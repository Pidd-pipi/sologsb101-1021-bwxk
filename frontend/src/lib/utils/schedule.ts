/**
 * 周排期工具
 * - 工作日（周一至周五）判定、日期加减与工作周展开
 * - 每位执刀人每个工作日的排期容量（分钟）与占用统计
 * - 未完工工序的自动顺延布局：刀法顺序或时长改动后，后续未完工工序
 *   顺延到下一个有余额的工作日，已刻完的照旧保留原计划日
 * 全部被 /carve 看板、印石台账与导出清单消费。
 */
import type { Carve } from '$lib/types/carve';

/** 每位执刀人每个工作日的排期容量（分钟） */
export const DAILY_CAPACITY_MINUTES = 240;

export const WEEKDAY_LABEL: readonly string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 今天（本地时区）yyyy-MM-dd */
export function todayStr(): string {
  return toDateStr(new Date());
}

export function toDateStr(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map((item) => Number.parseInt(item, 10));
  return new Date(year || 1970, (month || 1) - 1, day || 1);
}

export function addDays(dateStr: string, days: number): string {
  const date = parseDate(dateStr);
  date.setDate(date.getDate() + days);
  return toDateStr(date);
}

/** 是否工作日（周一至周五） */
export function isWorkday(dateStr: string): boolean {
  const day = parseDate(dateStr).getDay();
  return day >= 1 && day <= 5;
}

/** 调整为工作日：周末顺延到下周一 */
export function toWorkday(dateStr: string): string {
  let cursor = dateStr;
  while (!isWorkday(cursor)) cursor = addDays(cursor, 1);
  return cursor;
}

/** 某日期所在工作周（周一至周五，共 5 天） */
export function workdaysOfWeek(anchor: string): string[] {
  const day = parseDate(anchor).getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = addDays(anchor, mondayOffset);
  return [0, 1, 2, 3, 4].map((offset) => addDays(monday, offset));
}

export function weekdayLabel(dateStr: string): string {
  return WEEKDAY_LABEL[parseDate(dateStr).getDay()] ?? '';
}

const occupyKey = (operator: string, date: string): string => `${operator}@${date}`;

/** 某执刀人某日已排时长（含已完成工序；excludeId 用于编辑时排除自身） */
export function usedMinutesOn(carves: Carve[], operator: string, date: string, excludeId?: string): number {
  return carves
    .filter(
      (carve) =>
        carve.id !== excludeId &&
        carve.planDate === date &&
        carve.operator.trim() !== '' &&
        carve.operator.trim() === operator.trim(),
    )
    .reduce((sum, carve) => sum + (Number.isFinite(carve.minutes) ? carve.minutes : 0), 0);
}

/** 某执刀人某日剩余可排时长 */
export function capacityLeftOn(carves: Carve[], operator: string, date: string, excludeId?: string): number {
  return DAILY_CAPACITY_MINUTES - usedMinutesOn(carves, operator, date, excludeId);
}

/**
 * 保存前容量校验：同一人同一天的排期总量超出容量即拒绝。
 * 同稿中排在本工序之后（seq 更大）且未完工的工序不计入——它们会被顺延重排；
 * 已完成的工序照旧占用当天容量。返回错误文案，空串表示通过。
 */
export function capacityError(
  carves: Carve[],
  candidate: { id: string | null; designId: string; seq: number; operator: string; planDate: string; minutes: number },
): string {
  const operator = candidate.operator.trim();
  if (!candidate.planDate || !operator) return '';
  if (!isWorkday(candidate.planDate)) return `${candidate.planDate} 不是工作日，仅周一至周五可排期`;
  if (!Number.isFinite(candidate.minutes) || candidate.minutes <= 0) return '时长需为正数分钟';
  if (candidate.minutes > DAILY_CAPACITY_MINUTES) {
    return `单道工序 ${candidate.minutes} 分钟已超过每日容量 ${DAILY_CAPACITY_MINUTES} 分钟，请拆分工序`;
  }
  const used = carves
    .filter((carve) => {
      if (carve.id === candidate.id) return false;
      if (carve.planDate !== candidate.planDate) return false;
      if (carve.operator.trim() !== operator) return false;
      // 同稿后续未完工工序会被顺延，不占用校验口径
      if (carve.designId === candidate.designId && carve.state !== 'done' && carve.seq > candidate.seq) return false;
      return true;
    })
    .reduce((sum, carve) => sum + carve.minutes, 0);
  if (used + candidate.minutes > DAILY_CAPACITY_MINUTES) {
    return `${operator} 在 ${candidate.planDate} 已排 ${used} 分钟，加上本道 ${candidate.minutes} 分钟超出每日容量 ${DAILY_CAPACITY_MINUTES} 分钟；请改选其它工作日，或留空计划日进入待排区`;
  }
  return '';
}

export interface ScheduleAssignment {
  id: string;
  planDate: string;
}

export interface LayoutOptions {
  /** 只重排 seq ≥ fromSeq 的未完工工序（之前的照旧），默认 1 */
  fromSeq?: number;
  /** 是否把待排区（无计划日）的工序也排入，默认 false */
  includeBacklog?: boolean;
}

/**
 * 自动顺延布局：按工序顺序把未完工工序排进「下一个有余额的工作日」。
 * - 已完成的工序照旧保留原计划日，并继续占用当天容量
 * - fromSeq 之前的未完工工序保持原计划日不变
 * - 未填执刀人、或单道时长超过每日容量的工序留在待排区
 * 返回需要改动的工序（计划日有变化才列入）。
 */
export function layoutDesignSchedule(
  all: Carve[],
  designId: string,
  today: string,
  options: LayoutOptions = {},
): ScheduleAssignment[] {
  const { fromSeq = 1, includeBacklog = false } = options;
  const steps = all
    .filter((carve) => carve.designId === designId)
    .sort((a, b) => a.seq - b.seq);

  // 占用表：其它印稿的已排工序全部计入；本稿工序在遍历中逐个计入
  const used = new Map<string, number>();
  const occupy = (operator: string, date: string, minutes: number): void => {
    const key = occupyKey(operator, date);
    used.set(key, (used.get(key) ?? 0) + minutes);
  };
  const leftOn = (operator: string, date: string): number =>
    DAILY_CAPACITY_MINUTES - (used.get(occupyKey(operator, date)) ?? 0);

  all.forEach((carve) => {
    if (carve.designId === designId) return;
    if (!carve.planDate || carve.operator.trim() === '') return;
    occupy(carve.operator.trim(), carve.planDate, carve.minutes);
  });

  const assignments: ScheduleAssignment[] = [];
  let cursor = today;
  for (const step of steps) {
    const operator = step.operator.trim();
    const keepAsIs = step.state === 'done' || step.seq < fromSeq;
    if (keepAsIs) {
      // 照旧：保留原计划日并计入占用，游标不早于已确认的日期
      if (step.planDate && operator) {
        occupy(operator, step.planDate, step.minutes);
        if (step.planDate > cursor) cursor = step.planDate;
      }
      continue;
    }
    if (operator === '' || step.minutes > DAILY_CAPACITY_MINUTES) continue;
    if (!step.planDate && !includeBacklog) continue;
    let date = toWorkday(cursor);
    while (leftOn(operator, date) < step.minutes) date = toWorkday(addDays(date, 1));
    occupy(operator, date, step.minutes);
    cursor = date;
    if (step.planDate !== date) assignments.push({ id: step.id, planDate: date });
  }
  return assignments;
}

/** 若干印稿的预计完成日：未完工工序中最晚的计划日；无已排未完工工序返回空串 */
export function estimateFinishDate(carves: Carve[], designIds: string[]): string {
  const dates = carves
    .filter((carve) => designIds.includes(carve.designId) && carve.state !== 'done' && carve.planDate !== '')
    .map((carve) => carve.planDate)
    .sort();
  return dates[dates.length - 1] ?? '';
}

/** 若干印稿未完工工序的执刀人（去重，按出现顺序） */
export function operatorsOf(carves: Carve[], designIds: string[]): string[] {
  const result: string[] = [];
  carves
    .filter((carve) => designIds.includes(carve.designId) && carve.state !== 'done')
    .forEach((carve) => {
      const operator = carve.operator.trim();
      if (operator !== '' && !result.includes(operator)) result.push(operator);
    });
  return result;
}

/** 待排区：无计划日的未完工工序 */
export function backlogOf(carves: Carve[]): Carve[] {
  return carves
    .filter((carve) => carve.state !== 'done' && carve.planDate === '')
    .sort((a, b) => (a.designId === b.designId ? a.seq - b.seq : a.designId.localeCompare(b.designId)));
}
