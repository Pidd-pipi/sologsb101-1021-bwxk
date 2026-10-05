/**
 * 周排期工具
 * - 工作日（周一至周五）与 yyyy-MM-dd 日期串换算、周视图日期展开
 * - 执刀人 × 计划日 的容量核算（每日容量 DAILY_CAPACITY_MINUTES，超出即拒绝保存）
 * - 顺延重排：刀法顺序或时长改动后，未完工工序顺延到下一个有余额的工作日，已刻完的照旧
 * - 预计完成日 / 执刀人汇总（印石台账与导出清单共用）
 */
import { DAILY_CAPACITY_MINUTES, type Carve } from '$lib/types/carve';

export const DAY_MS = 86400000;

const WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

export function toDateStr(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayStr(): string {
  return toDateStr(new Date());
}

export function parseDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
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

/** 若是工作日则原样返回，否则顺延到下一个工作日 */
export function workdayOrNext(dateStr: string): string {
  let cursor = dateStr;
  let guard = 0;
  while (!isWorkday(cursor) && guard < 10) {
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return cursor;
}

/** 下一个工作日（不含当天） */
export function nextWorkday(dateStr: string): string {
  return workdayOrNext(addDays(dateStr, 1));
}

/** 所在周的周一 */
export function weekStart(dateStr: string): string {
  const date = parseDate(dateStr);
  const day = date.getDay();
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  return toDateStr(date);
}

export interface WeekDay {
  date: string;
  /** MM-DD */
  label: string;
  weekLabel: string;
  workday: boolean;
  isToday: boolean;
}

/** 以 anchor 所在周为准展开 7 天（周一 → 周日） */
export function weekDays(anchor: string): WeekDay[] {
  const start = weekStart(anchor);
  const today = todayStr();
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    return {
      date,
      label: date.slice(5),
      weekLabel: WEEK_LABELS[parseDate(date).getDay()] as string,
      workday: isWorkday(date),
      isToday: date === today,
    };
  });
}

/** 占用键：执刀人 + 计划日 */
function slotKey(operator: string, planDate: string): string {
  return `${operator}@${planDate}`;
}

/** 某「执刀人 × 计划日」已占分钟数（可排除正在编辑的工序） */
export function usedMinutes(carves: Carve[], operator: string, planDate: string, excludeId = ''): number {
  return carves
    .filter((carve) => carve.id !== excludeId && carve.planDate === planDate && carve.operator === operator)
    .reduce((sum, carve) => sum + carve.minutes, 0);
}

/** 某「执刀人 × 计划日」剩余容量 */
export function capacityLeft(carves: Carve[], operator: string, planDate: string, excludeId = ''): number {
  return DAILY_CAPACITY_MINUTES - usedMinutes(carves, operator, planDate, excludeId);
}

/** 占用某「执刀人 × 计划日」的工序（冲突提示展示被占时段） */
export function occupyingCarves(carves: Carve[], operator: string, planDate: string, excludeId = ''): Carve[] {
  return carves
    .filter((carve) => carve.id !== excludeId && carve.planDate === planDate && carve.operator === operator)
    .sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt);
}

/**
 * 顺延重排：已完成的工序照旧；未完工且已排期的工序按计划日先后扫描，
 * 当天容量不足（或计划日已过期 / 落在周末）即顺延到下一个有余额的工作日（不早于今天）；
 * 待排区（无计划日）的工序不动。返回需要写回的工序（仅 planDate 有变化的）。
 */
export function rescheduleCarves(all: Carve[], today = todayStr()): Carve[] {
  const usage = new Map<string, number>();
  const take = (operator: string, date: string, minutes: number): void => {
    const key = slotKey(operator, date);
    usage.set(key, (usage.get(key) ?? 0) + minutes);
  };
  // 已刻完的照旧：按计划日原地占位
  all
    .filter((carve) => carve.state === 'done' && carve.planDate)
    .forEach((carve) => take(carve.operator, carve.planDate, carve.minutes));

  const movable = all
    .filter((carve) => carve.state !== 'done' && carve.planDate)
    .sort((a, b) =>
      a.planDate === b.planDate ? a.seq - b.seq || a.createdAt - b.createdAt : a.planDate.localeCompare(b.planDate),
    );

  const changed: Carve[] = [];
  movable.forEach((carve) => {
    let date = carve.planDate < today ? today : carve.planDate;
    date = workdayOrNext(date);
    let guard = 0;
    while ((usage.get(slotKey(carve.operator, date)) ?? 0) + carve.minutes > DAILY_CAPACITY_MINUTES && guard < 370) {
      date = nextWorkday(date);
      guard += 1;
    }
    take(carve.operator, date, carve.minutes);
    if (date !== carve.planDate) changed.push({ ...carve, planDate: date });
  });
  return changed;
}

/** 为待排工序建议一个有余额的工作日 */
export function suggestPlanDate(carves: Carve[], operator: string, minutes: number, from = todayStr()): string {
  let date = workdayOrNext(from);
  let guard = 0;
  while (operator && usedMinutes(carves, operator, date) + minutes > DAILY_CAPACITY_MINUTES && guard < 60) {
    date = nextWorkday(date);
    guard += 1;
  }
  return date;
}

/** 一组工序的排期汇总（印石台账 / 导出清单 / 看板共用） */
export interface ScheduleSummary {
  /** 未完工工序的执刀人（去重，忽略空串） */
  operators: string[];
  /** 预计完成日：未完工且已排期工序中最晚的计划日；无则空串 */
  eta: string;
  /** 未完工但未排期（待排区）的工序数 */
  unscheduled: number;
  /** 未完工工序总数 */
  unfinished: number;
}

export function summarizeSchedule(steps: Carve[]): ScheduleSummary {
  const unfinished = steps.filter((step) => step.state !== 'done');
  const scheduled = unfinished.filter((step) => step.planDate);
  return {
    operators: [...new Set(unfinished.map((step) => step.operator).filter((name) => name.trim().length > 0))],
    eta: scheduled.reduce((max, step) => (step.planDate > max ? step.planDate : max), ''),
    unscheduled: unfinished.length - scheduled.length,
    unfinished: unfinished.length,
  };
}

/** 预计完成日展示文案：无未完工序为「—」，有待排缺口时追加提示 */
export function etaText(summary: ScheduleSummary): string {
  if (summary.unfinished === 0) return '—';
  const base = summary.eta || '待排区';
  return summary.unscheduled > 0 ? `${base}（另 ${summary.unscheduled} 道待排）` : base;
}

/** 导出清单用单行排期文案：执刀人 + 预计完成日 */
export function scheduleLine(steps: Carve[]): string {
  if (steps.length === 0) return '未排工序';
  const summary = summarizeSchedule(steps);
  if (summary.unfinished === 0) {
    const ops = [...new Set(steps.map((step) => step.operator).filter((name) => name.trim().length > 0))];
    return `执刀人 ${ops.length > 0 ? ops.join('、') : '未填'}　预计完成日 已完成`;
  }
  const ops = summary.operators.length > 0 ? summary.operators.join('、') : '未填';
  return `执刀人 ${ops}　预计完成日 ${etaText(summary)}`;
}
