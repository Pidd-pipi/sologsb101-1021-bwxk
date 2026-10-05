/**
 * 刻制工序 store（Svelte writable / derived）
 * 维护工序顺序与完成计数；全部完成即回写印稿为已刻（印石状态置为「已刻」）。
 * 周排期：保存时按「同一人每天容量」校验并防止跨页签覆盖；
 * 刀法顺序或时长改动后，后续未完工工序自动顺延到下一个有余额的工作日。
 */
import { derived, get, writable } from 'svelte/store';
import { createId, db } from '$lib/utils/db';
import {
  nextCarveState,
  suggestMinutes,
  STANDARD_KNIFE_SEQUENCE,
  type Carve,
  type CarveDraft,
  type CarveState,
  type KnifeMethod,
} from '$lib/types/carve';
import { capacityError, layoutDesignSchedule, todayStr } from '$lib/utils/schedule';
import { designById, updateDesign } from './designStore';
import { updateStone } from './stoneStore';

export const carves = writable<Carve[]>([]);
export const carveLoading = writable(false);
export const carveReady = writable(false);
export const carveError = writable('');

export const carveTotals = derived(carves, ($carves) => {
  const done = $carves.filter((carve) => carve.state === 'done').length;
  const doing = $carves.filter((carve) => carve.state === 'doing').length;
  const remainingMinutes = $carves
    .filter((carve) => carve.state !== 'done')
    .reduce((sum, carve) => sum + carve.minutes, 0);
  return {
    total: $carves.length,
    done,
    doing,
    remainingMinutes,
    percent: $carves.length === 0 ? 0 : Math.round((done / $carves.length) * 100),
  };
});

export async function loadCarves(): Promise<void> {
  carveLoading.set(true);
  try {
    const rows = await db.carves.toArray();
    rows.sort((a, b) => (a.designId === b.designId ? a.seq - b.seq : a.designId.localeCompare(b.designId)));
    carves.set(rows);
    carveError.set('');
    carveReady.set(true);
  } catch (err) {
    carveError.set(err instanceof Error ? err.message : '工序读取失败');
    carveReady.set(true);
  } finally {
    carveLoading.set(false);
  }
}

export function carvesOfDesign(designId: string): Carve[] {
  return get(carves)
    .filter((carve) => carve.designId === designId)
    .sort((a, b) => a.seq - b.seq);
}

export function nextSeq(designId: string): number {
  const list = carvesOfDesign(designId);
  return list.length === 0 ? 1 : Math.max(...list.map((carve) => carve.seq)) + 1;
}

export async function updateCarve(id: string, patch: Partial<Carve>): Promise<void> {
  await db.carves.update(id, { ...patch, updatedAt: Date.now() } as never);
  await loadCarves();
}

export interface SaveCarveResult {
  ok: boolean;
  /** 失败原因（容量超出 / 跨页签冲突等）；成功时为空串 */
  reason: string;
}

/**
 * 带守卫的工序保存（新增或编辑）：
 * - 同事务内重读最新数据校验容量，同一人每天排期超出即拒绝，缺口留待排区
 * - 两个页签同时保存时以后提交时的库内状态为准：先确认的安排不被覆盖，
 *   后提交者保存失败、草稿保留在对话框中，并重新载入看到被占时段
 * - 保存成功后若刀法 / 时长 / 顺序有变化，后续未完工工序自动顺延
 */
export async function saveCarve(
  draft: CarveDraft,
  editingId: string | null,
  baseUpdatedAt: number | null,
): Promise<SaveCarveResult> {
  const cleaned: CarveDraft = { ...draft, operator: draft.operator.trim(), planDate: draft.planDate.trim() };
  if (cleaned.planDate !== '' && cleaned.operator === '') {
    return { ok: false, reason: '已选计划日，请先填写执刀人；或清空计划日进入待排区' };
  }
  let scheduleChanged = false;
  let result: SaveCarveResult;
  try {
    result = await db.transaction('rw', db.carves, async (): Promise<SaveCarveResult> => {
      const latest = await db.carves.toArray();
      const current = editingId ? (latest.find((row) => row.id === editingId) ?? null) : null;
      if (editingId && !current) {
        return { ok: false, reason: '该工序已在其它页签被删除，草稿未保存' };
      }
      if (current && baseUpdatedAt !== null && current.updatedAt !== baseUpdatedAt) {
        return { ok: false, reason: '另一页签已先保存了这道工序，草稿已保留；请核对最新安排后再提交' };
      }
      const error = capacityError(latest, {
        id: editingId,
        designId: cleaned.designId,
        seq: cleaned.seq,
        operator: cleaned.operator,
        planDate: cleaned.planDate,
        minutes: cleaned.minutes,
      });
      if (error) return { ok: false, reason: error };
      const now = Date.now();
      if (editingId) {
        scheduleChanged =
          current !== null &&
          (current.minutes !== cleaned.minutes ||
            current.knifeMethod !== cleaned.knifeMethod ||
            current.seq !== cleaned.seq);
        await db.carves.update(editingId, { ...cleaned, updatedAt: now } as never);
      } else {
        scheduleChanged = true;
        await db.carves.put({ ...cleaned, id: createId('carve'), createdAt: now, updatedAt: now });
      }
      return { ok: true, reason: '' };
    });
  } catch (err) {
    result = { ok: false, reason: err instanceof Error ? err.message : '保存失败' };
  }
  // 无论成败都重新载入：失败时让后提交者看到先确认安排占用的时段
  await loadCarves();
  if (result.ok && scheduleChanged) await rescheduleDesign(cleaned.designId, cleaned.seq + 1);
  return result;
}

/**
 * 自动顺延：把某印稿 seq ≥ fromSeq 的未完工工序重排到下一个有余额的工作日。
 * 已完成的照旧；includeBacklog 为 true 时把待排区工序也排入。
 * 返回计划日发生变化的工序数。
 */
export async function rescheduleDesign(
  designId: string,
  fromSeq = 1,
  includeBacklog = false,
): Promise<number> {
  if (!designId) return 0;
  const changed = await db.transaction('rw', db.carves, async () => {
    const latest = await db.carves.toArray();
    const assignments = layoutDesignSchedule(latest, designId, todayStr(), { fromSeq, includeBacklog });
    if (assignments.length === 0) return 0;
    const now = Date.now();
    const rows = latest
      .filter((row) => assignments.some((item) => item.id === row.id))
      .map((row) => ({
        ...row,
        planDate: (assignments.find((item) => item.id === row.id) as { planDate: string }).planDate,
        updatedAt: now,
      }));
    await db.carves.bulkPut(rows);
    return assignments.length;
  });
  if (changed > 0) await loadCarves();
  return changed;
}

export async function removeCarve(id: string): Promise<void> {
  const target = get(carves).find((carve) => carve.id === id);
  await db.carves.delete(id);
  if (target) {
    const rest = carvesOfDesign(target.designId)
      .filter((carve) => carve.id !== id)
      .map((carve, index) => ({ ...carve, seq: index + 1, updatedAt: Date.now() }));
    if (rest.length > 0) await db.carves.bulkPut(rest);
  }
  await loadCarves();
}

/** 拖拽 / 上下移调序：重编号后，自首个变动的位置起顺延后续未完工工序 */
export async function reorderCarves(designId: string, orderedIds: string[]): Promise<void> {
  const beforeIds = carvesOfDesign(designId).map((carve) => carve.id);
  const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
  const rows = carvesOfDesign(designId)
    .sort((a, b) => {
      const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
      const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    })
    .map((carve, index) => ({ ...carve, seq: index + 1, updatedAt: Date.now() }));
  await db.carves.bulkPut(rows);
  // 首个顺序发生变化的位置：其后的未完工工序需要顺延重排
  let fromSeq = rows.length + 1;
  for (let index = 0; index < rows.length; index += 1) {
    if (beforeIds[index] !== rows[index]?.id) {
      fromSeq = index + 1;
      break;
    }
  }
  await loadCarves();
  if (fromSeq <= rows.length) await rescheduleDesign(designId, fromSeq);
}

export async function batchUpdateCarves(ids: string[], patch: Partial<Carve>): Promise<void> {
  if (ids.length === 0) return;
  const now = Date.now();
  const rows = get(carves)
    .filter((carve) => ids.includes(carve.id))
    .map((carve) => ({ ...carve, ...patch, updatedAt: now }));
  await db.carves.bulkPut(rows);
  await loadCarves();
}

/**
 * 推进工序状态；某印稿全部工序完成时回写印石状态为「已刻」。
 * 返回推进后的状态，便于页面提示。
 */
export async function advanceCarve(id: string): Promise<CarveState> {
  const carve = get(carves).find((item) => item.id === id);
  if (!carve) return 'todo';
  const next = nextCarveState(carve.state);
  if (next === carve.state) return carve.state;
  await updateCarve(id, { state: next });

  const designId = carve.designId;
  const steps = carvesOfDesign(designId);
  const allDone = steps.length > 0 && steps.every((step) => step.state === 'done');
  if (allDone) {
    const design = designById(designId);
    if (design) {
      await updateDesign(designId, {});
      await updateStone(design.stoneId, { state: 'carved' });
    }
  }
  return next;
}

/** 按标准刀法序列生成工序（已存在的序号跳过；新工序先进待排区，由自动排期落位） */
export async function generateStandardSequence(designId: string): Promise<number> {
  const existing = carvesOfDesign(designId);
  const now = Date.now();
  let created = 0;
  for (let index = 0; index < STANDARD_KNIFE_SEQUENCE.length; index += 1) {
    const seq = index + 1;
    if (existing.some((carve) => carve.seq === seq)) continue;
    const method = STANDARD_KNIFE_SEQUENCE[index] as KnifeMethod;
    await db.carves.put({
      id: createId('carve'),
      designId,
      seq,
      knifeMethod: method,
      minutes: suggestMinutes(method),
      operator: '',
      planDate: '',
      state: 'todo',
      createdAt: now,
      updatedAt: now,
    });
    created += 1;
  }
  await loadCarves();
  return created;
}
