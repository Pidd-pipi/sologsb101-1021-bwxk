/**
 * 刻制工序 store（Svelte writable / derived）
 * 维护工序顺序与完成计数；全部完成即回写印稿为已刻（印石状态置为「已刻」）。
 * 周排期：保存时按「执刀人 × 计划日」校验当日容量（基于 IndexedDB 实时读取，
 * 两个页签同时保存时后提交者保留草稿、不覆盖先确认的安排）；刀法顺序或时长
 * 改动后自动顺延未完工工序到下一个有余额的工作日，已刻完的照旧。
 */
import { derived, get, writable } from 'svelte/store';
import { createId, db } from '$lib/utils/db';
import {
  nextCarveState,
  suggestMinutes,
  DAILY_CAPACITY_MINUTES,
  STANDARD_KNIFE_SEQUENCE,
  type Carve,
  type CarveDraft,
  type CarveState,
  type KnifeMethod,
} from '$lib/types/carve';
import { isWorkday, occupyingCarves, rescheduleCarves, usedMinutes } from '$lib/utils/schedule';
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

/** 保存校验结果：ok=false 时页面保留草稿，message 说明原因，occupied 列出被占时段 */
export interface CarveSaveResult {
  ok: boolean;
  message: string;
  occupied: Carve[];
}

function reject(message: string, occupied: Carve[] = []): CarveSaveResult {
  return { ok: false, message, occupied };
}

/**
 * 顺延重排：未完工且已排期的工序容量不足 / 计划日过期时，顺延到下一个有余额的工作日。
 * 返回本次被顺延的工序数。
 */
export async function applyReschedule(): Promise<number> {
  const all = await db.carves.toArray();
  const changed = rescheduleCarves(all);
  if (changed.length > 0) {
    const now = Date.now();
    await db.carves.bulkPut(changed.map((carve) => ({ ...carve, updatedAt: now })));
  }
  return changed.length;
}

/**
 * 新增 / 编辑工序（含周排期校验）：
 * - 计划日非空时必填执刀人，且须为工作日；
 * - 容量以保存当下 IndexedDB 的实时数据核算，同一执刀人当日超出容量即拒绝，缺口留待排区；
 * - 编辑时比对 updatedAt，若该工序已被其他页签改动则拒绝，避免覆盖先确认的安排；
 * - 保存成功后自动顺延受影响的未完工工序。
 */
export async function saveCarveWithCheck(draft: CarveDraft, editing: Carve | null): Promise<CarveSaveResult> {
  const operator = draft.operator.trim();
  const planDate = draft.planDate;
  if (planDate) {
    if (!operator) return reject('已填计划日，请同时填写执刀人');
    if (!isWorkday(planDate)) return reject('计划日需为工作日（周一至周五），周末不排工');
  }

  // 实时读取 IndexedDB：两个页签同时保存时，以先确认落库的安排为准
  const fresh = await db.carves.toArray();
  if (editing) {
    const row = fresh.find((carve) => carve.id === editing.id);
    if (!row) return reject('该工序已被其他页签删除，草稿未保存，请关闭后刷新');
    if (row.updatedAt !== editing.updatedAt) {
      return reject('该工序已被其他页签修改，为避免覆盖先确认的安排，本次未保存；请关闭后重新编辑');
    }
  }

  if (planDate) {
    const used = usedMinutes(fresh, operator, planDate, editing?.id ?? '');
    if (used + draft.minutes > DAILY_CAPACITY_MINUTES) {
      return reject(
        `${operator} 在 ${planDate} 的排期容量不足：已占 ${used}/${DAILY_CAPACITY_MINUTES} 分钟，缺口留待排区`,
        occupyingCarves(fresh, operator, planDate, editing?.id ?? ''),
      );
    }
  }

  const now = Date.now();
  if (editing) {
    await db.carves.update(editing.id, { ...draft, operator, updatedAt: now } as never);
  } else {
    await db.carves.put({ ...draft, operator, id: createId('carve'), createdAt: now, updatedAt: now });
  }
  await applyReschedule();
  await loadCarves();
  return { ok: true, message: '', occupied: [] };
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

export async function reorderCarves(designId: string, orderedIds: string[]): Promise<void> {
  const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
  const rows = carvesOfDesign(designId)
    .sort((a, b) => {
      const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
      const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    })
    .map((carve, index) => ({ ...carve, seq: index + 1, updatedAt: Date.now() }));
  await db.carves.bulkPut(rows);
  // 刀法顺序改动：后续未完工工序顺延到下一个有余额的工作日
  await applyReschedule();
  await loadCarves();
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

/** 按标准刀法序列生成工序（已存在的序号跳过） */
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
