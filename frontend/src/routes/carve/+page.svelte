<script lang="ts">
  /**
   * /carve 刻制工序看板（周排期）
   * 按印稿列出刀法步骤、拖拽/上下移排序、逐条标记完成；全部完成即回写印石为已刻。
   * 周排期：工序写执刀人与计划日，同一人每天容量超出即拒绝保存（缺口留待排区）；
   * 刀法顺序或时长改动后，后续未完工工序自动顺延到下一个有余额的工作日，已刻完的照旧。
   * 消费 Carve、Design；复用 <StatBadge>、<FilterBar>、<EmptyPanel>。
   */
  import { push, router } from '$lib/router';
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import FilterBar, {
    encodeQuery,
    firstValue,
    parseQuery,
    type FilterSelectConfig,
  } from '$lib/components/common/FilterBar.svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import { progressOfDesign, useCarveProgress } from '$lib/hooks/useCarveProgress';
  import {
    advanceCarve,
    batchUpdateCarves,
    carves,
    carvesOfDesign,
    generateStandardSequence,
    nextSeq,
    removeCarve,
    reorderCarves,
    rescheduleDesign,
    saveCarve,
  } from '$lib/stores/carveStore';
  import { currentDesignId, designs, setCurrentDesign } from '$lib/stores/designStore';
  import { stones } from '$lib/stores/stoneStore';
  import {
    CARVE_STATE_COLOR,
    CARVE_STATE_LABEL,
    CARVE_STATE_OPTIONS,
    KNIFE_METHOD_COLOR,
    KNIFE_METHOD_LABEL,
    KNIFE_METHOD_OPTIONS,
    createEmptyCarveDraft,
    type Carve,
    type CarveDraft,
    type CarveState,
    type KnifeMethod,
  } from '$lib/types/carve';
  import { DESIGN_STYLE_LABEL } from '$lib/types/design';
  import {
    DAILY_CAPACITY_MINUTES,
    addDays,
    backlogOf,
    todayStr,
    usedMinutesOn,
    weekdayLabel,
    workdaysOfWeek,
  } from '$lib/utils/schedule';

  const { progressByDesign, totals } = useCarveProgress();
  const queryValues = $derived(parseQuery(router.querystring ?? ''));

  const activeDesignId = $derived($currentDesignId ?? $designs[0]?.id ?? '');
  const activeDesign = $derived($designs.find((design) => design.id === activeDesignId) ?? null);
  const stoneName = $derived(
    stones ? ($stones.find((stone) => stone.id === activeDesign?.stoneId)?.name ?? '—') : '—',
  );

  const steps = $derived(
    carvesOfDesign(activeDesignId).filter((carve) => {
      const keyword = firstValue(queryValues, 'kw').trim();
      const methods = (queryValues.knifeMethod ?? []) as KnifeMethod[];
      const states = (queryValues.state ?? []) as CarveState[];
      if (keyword.length > 0 && !`${carve.operator}${carve.minutes}`.includes(keyword)) return false;
      if (methods.length > 0 && !methods.includes(carve.knifeMethod)) return false;
      if (states.length > 0 && !states.includes(carve.state)) return false;
      return true;
    }),
  );

  const progress = $derived(progressOfDesign($progressByDesign, activeDesignId));

  /* ------------------------------ 周排期 ------------------------------ */

  const today = todayStr();
  let weekAnchor = $state(todayStr());
  const weekDays = $derived(workdaysOfWeek(weekAnchor));

  interface DayGroup {
    operator: string;
    used: number;
    steps: Carve[];
  }

  interface DayColumn {
    date: string;
    groups: DayGroup[];
  }

  /** 一周 5 个工作日，按执刀人分组展示占用（容量按人按天计算，跨印稿汇总） */
  const dayColumns = $derived.by((): DayColumn[] => {
    return weekDays.map((date) => {
      const planned = $carves.filter((carve) => carve.planDate === date);
      const operators = [...new Set(planned.map((carve) => carve.operator.trim() || '未派'))];
      const groups = operators
        .map((operator) => {
          const own = planned
            .filter((carve) => (carve.operator.trim() || '未派') === operator)
            .sort((a, b) => (a.designId === b.designId ? a.seq - b.seq : a.designId.localeCompare(b.designId)));
          return { operator, used: own.reduce((sum, carve) => sum + carve.minutes, 0), steps: own };
        })
        .sort((a, b) => b.used - a.used);
      return { date, groups };
    });
  });

  /** 待排区：无计划日的未完工工序（全部印稿） */
  const backlog = $derived(backlogOf($carves));

  let scheduleNotice = $state('');

  function designTextOf(designId: string): string {
    return $designs.find((design) => design.id === designId)?.sealText ?? '（印稿已删除）';
  }

  async function autoSchedule(): Promise<void> {
    if (!activeDesignId) return;
    const changed = await rescheduleDesign(activeDesignId, 1, true);
    scheduleNotice =
      changed > 0 ? `已为当前印稿排入 / 顺延 ${changed} 道工序` : '当前印稿排期无需调整（待排工序请先填执刀人）';
  }

  /* ------------------------------ 筛选与工序操作 ------------------------------ */

  function updateQuery(patch: Record<string, string | string[] | undefined>): void {
    const merged: Record<string, string[]> = { ...parseQuery(router.querystring ?? '') };
    Object.entries(patch).forEach(([key, value]) => {
      if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete merged[key];
      else merged[key] = Array.isArray(value) ? value : [value];
    });
    const qs = encodeQuery(merged);
    void push(`/carve${qs.length > 0 ? `?${qs}` : ''}`);
  }

  const selects: FilterSelectConfig[] = [
    { key: 'knifeMethod', label: '刀法', options: KNIFE_METHOD_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
    { key: 'state', label: '状态', options: CARVE_STATE_OPTIONS.map((item) => ({ label: item.label, value: item.value })) },
  ];

  let dialogOpen = $state(false);
  let editing = $state<Carve | null>(null);
  let draft = $state<CarveDraft>(createEmptyCarveDraft('', 1));
  let saveError = $state('');
  let pendingDelete = $state<Carve | null>(null);
  let selectedIds = $state<string[]>([]);
  let dragId = $state('');

  function openCreate(): void {
    if (!activeDesignId) return;
    editing = null;
    draft = createEmptyCarveDraft(activeDesignId, nextSeq(activeDesignId));
    saveError = '';
    dialogOpen = true;
  }

  function openEdit(carve: Carve): void {
    editing = carve;
    draft = {
      designId: carve.designId,
      seq: carve.seq,
      knifeMethod: carve.knifeMethod,
      minutes: carve.minutes,
      operator: carve.operator,
      planDate: carve.planDate,
      state: carve.state,
    };
    saveError = '';
    dialogOpen = true;
  }

  /** 保存失败（容量超出 / 跨页签冲突）时草稿保留在对话框中，页面已刷新出被占时段 */
  async function submit(): Promise<void> {
    saveError = '';
    const result = await saveCarve({ ...draft }, editing?.id ?? null, editing?.updatedAt ?? null);
    if (!result.ok) {
      saveError = result.reason;
      return;
    }
    dialogOpen = false;
    editing = null;
    selectedIds = [];
  }

  /** 对话框内实时容量提示（按当前执刀人 + 计划日，排除本道） */
  const capacityHint = $derived.by(() => {
    if (!dialogOpen || !draft.planDate || draft.operator.trim() === '') return '';
    const used = usedMinutesOn($carves, draft.operator, draft.planDate, editing?.id);
    const left = Math.max(0, DAILY_CAPACITY_MINUTES - used);
    return `${draft.operator.trim()} 在 ${draft.planDate} 已排 ${used} 分钟，剩余 ${left} 分钟（每日容量 ${DAILY_CAPACITY_MINUTES} 分钟）`;
  });

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    await removeCarve(pendingDelete.id);
    pendingDelete = null;
  }

  async function generate(): Promise<void> {
    if (!activeDesignId) return;
    await generateStandardSequence(activeDesignId);
  }

  async function move(step: Carve, delta: number): Promise<void> {
    const list = carvesOfDesign(activeDesignId);
    const index = list.findIndex((carve) => carve.id === step.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) return;
    const ids = list.map((carve) => carve.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved as string);
    await reorderCarves(activeDesignId, ids);
  }

  async function handleDrop(targetId: string): Promise<void> {
    if (!dragId || dragId === targetId) return;
    const ids = carvesOfDesign(activeDesignId).map((carve) => carve.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    dragId = '';
    if (from < 0 || to < 0) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved as string);
    await reorderCarves(activeDesignId, ids);
  }

  function toggleSelect(id: string): void {
    selectedIds = selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id];
  }

  async function batchDone(): Promise<void> {
    await batchUpdateCarves(selectedIds, { state: 'done' });
    selectedIds = [];
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-xl tracking-wide text-ink">刻制工序看板 · 周排期</h2>
      <p class="mt-1 text-sm text-ink-soft">
        工序写执刀人与计划日；同一人每天容量 {DAILY_CAPACITY_MINUTES} 分钟，超出拒绝保存，缺口留待排区。
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <select
        class="gb-input w-[260px]"
        value={activeDesignId}
        onchange={(event) => setCurrentDesign((event.currentTarget as HTMLSelectElement).value)}
      >
        {#each $designs as design (design.id)}
          <option value={design.id}>
            {design.sealText}{design.adopted ? '（采用稿）' : ''} · {DESIGN_STYLE_LABEL[design.style]}
          </option>
        {/each}
      </select>
      <button class="gb-btn" onclick={() => void generate()}>生成标准序列</button>
      <button class="gb-btn" disabled={selectedIds.length === 0} onclick={() => void batchDone()}>
        批量完成（{selectedIds.length}）
      </button>
      <button class="gb-btn-primary" onclick={openCreate}>新增工序</button>
    </div>
  </div>

  {#if activeDesign}
    <div class="gb-panel flex flex-wrap items-center gap-3 text-sm text-ink-soft">
      <span class="text-ink">印文：{activeDesign.sealText}</span>
      <span>印石：{stoneName}</span>
      <span>{DESIGN_STYLE_LABEL[activeDesign.style]}</span>
      <span>释文：{activeDesign.annotation || '未填写'}</span>
    </div>
  {/if}

  <div class="flex flex-wrap gap-3">
    <StatBadge label="本稿工序" value={progress.total} suffix="道" tone="seal" />
    <StatBadge label="完成率" value={`${progress.percent}%`} percent={progress.percent} tone="jade" />
    <StatBadge label="已完成" value={progress.done} suffix="道" tone="jade" />
    <StatBadge label="进行中" value={progress.doing} suffix="道" tone="amber" />
    <StatBadge label="剩余时长" value={progress.remainingMinutes} suffix="分钟" />
    <StatBadge label="待排区" value={backlog.length} suffix="道" tone={backlog.length > 0 ? 'amber' : 'default'} />
    <StatBadge label="全局完成率" value={`${$totals.percent}%`} percent={$totals.percent} tone="ink" />
  </div>

  <section class="gb-panel space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-base text-ink">
        周排期（{weekDays[0]} ~ {weekDays[4]}，仅工作日）
      </h3>
      <div class="flex flex-wrap gap-2">
        <button class="gb-btn" onclick={() => (weekAnchor = addDays(weekAnchor, -7))}>上一周</button>
        <button class="gb-btn" onclick={() => (weekAnchor = todayStr())}>本周</button>
        <button class="gb-btn" onclick={() => (weekAnchor = addDays(weekAnchor, 7))}>下一周</button>
        <button class="gb-btn-primary" onclick={() => void autoSchedule()}>自动排期当前印稿</button>
      </div>
    </div>
    {#if scheduleNotice}
      <p class="text-xs text-jade">{scheduleNotice}</p>
    {/if}

    <div class="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {#each dayColumns as day (day.date)}
        <div
          class="rounded-lg border border-line bg-black/[0.02] p-2 {day.date === today ? 'ring-1 ring-seal/50' : ''}"
        >
          <div class="mb-1 flex items-baseline justify-between">
            <span class="text-xs font-medium text-ink">{weekdayLabel(day.date)}{day.date === today ? ' · 今天' : ''}</span>
            <span class="text-xs tabular-nums text-ink-soft">{day.date.slice(5)}</span>
          </div>
          {#each day.groups as group (group.operator)}
            <div class="mb-1.5">
              <div class="flex items-baseline justify-between text-xs">
                <span class="text-ink">{group.operator}</span>
                <span
                  class="tabular-nums {group.used > DAILY_CAPACITY_MINUTES ? 'font-medium text-seal' : 'text-ink-soft'}"
                >
                  {group.used}/{DAILY_CAPACITY_MINUTES}′
                </span>
              </div>
              <div class="mt-0.5 h-1 overflow-hidden rounded-full bg-black/10">
                <div
                  class="h-full rounded-full"
                  style="width:{Math.min(100, (group.used / DAILY_CAPACITY_MINUTES) * 100)}%;background:{group.used >
                  DAILY_CAPACITY_MINUTES
                    ? '#9c2b1f'
                    : '#3f6b57'}"
                ></div>
              </div>
              {#each group.steps as step (step.id)}
                <button
                  class="mt-1 block w-full rounded border border-line bg-paper-light px-1.5 py-0.5 text-left text-xs transition hover:border-seal/50 {step.state ===
                  'done'
                    ? 'opacity-60'
                    : ''}"
                  onclick={() => openEdit(step)}
                  title="点击编辑排期"
                >
                  <span style="color:{KNIFE_METHOD_COLOR[step.knifeMethod]}">{KNIFE_METHOD_LABEL[step.knifeMethod]}</span>
                  {designTextOf(step.designId)} · {step.minutes}′{step.state === 'done' ? '（已刻）' : ''}
                </button>
              {/each}
            </div>
          {:else}
            <p class="py-1 text-xs text-ink-soft">未排工</p>
          {/each}
        </div>
      {/each}
    </div>

    <div class="rounded-lg border border-dashed border-line p-2">
      <div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <span class="text-xs font-medium text-ink">待排区（{backlog.length} 道）</span>
        <span class="text-xs text-ink-soft">容量不足或未填执刀人的未完工工序在此等候；点条目可编辑排期</span>
      </div>
      {#if backlog.length === 0}
        <p class="text-xs text-ink-soft">没有待排工序。</p>
      {:else}
        <div class="flex flex-wrap gap-1">
          {#each backlog as step (step.id)}
            <button class="gb-tag transition hover:border-seal/60" onclick={() => openEdit(step)}>
              {designTextOf(step.designId)} · 第 {step.seq} 道 {KNIFE_METHOD_LABEL[step.knifeMethod]} · {step.minutes}′ · {step.operator.trim() || '未填执刀人'}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </section>

  <FilterBar
    keyword={firstValue(queryValues, 'kw')}
    placeholder="搜索执刀人 / 时长…"
    {selects}
    values={queryValues}
    onKeyword={(value) => updateQuery({ kw: value })}
    onSelect={(key, value) => updateQuery({ [key]: value })}
    onReset={() => updateQuery({ kw: undefined, knifeMethod: undefined, state: undefined })}
    hint={`共 ${steps.length} / ${progress.total} 道`}
  />

  {#if steps.length === 0}
    <EmptyPanel
      title={progress.total === 0 ? '该印稿还没有排工序' : '当前筛选条件下没有工序'}
      description={progress.total === 0
        ? '可一键生成标准刀法序列（冲刀 → 切刀 → 双刀 → 修整），新工序先进入待排区，再自动排期落位。'
        : '试着调整刀法或状态筛选条件。'}
      actionText="生成标准序列"
      secondaryText="重置筛选"
      onAction={() => void generate()}
      onSecondary={() => updateQuery({ kw: undefined, knifeMethod: undefined, state: undefined })}
    />
  {:else}
    <div class="space-y-2">
      {#each steps as step (step.id)}
        <div
          class="gb-panel flex flex-wrap items-center gap-3 {dragId === step.id ? 'opacity-50' : ''}"
          draggable="true"
          ondragstart={() => (dragId = step.id)}
          ondragover={(event) => event.preventDefault()}
          ondrop={() => void handleDrop(step.id)}
          role="listitem"
        >
          <span class="cursor-grab text-ink-soft" title="按住拖动可调整工序先后">⋮⋮</span>
          <input
            type="checkbox"
            checked={selectedIds.includes(step.id)}
            onchange={() => toggleSelect(step.id)}
            aria-label="选择工序"
          />
          <span class="gb-tag" style="color:#23282a;border-color:#23282a33">第 {step.seq} 道</span>
          <span class="gb-tag" style="color:{KNIFE_METHOD_COLOR[step.knifeMethod]};border-color:{KNIFE_METHOD_COLOR[step.knifeMethod]}66">
            {KNIFE_METHOD_LABEL[step.knifeMethod]}
          </span>
          <span class="gb-tag" style="color:{CARVE_STATE_COLOR[step.state]};border-color:{CARVE_STATE_COLOR[step.state]}66">
            {CARVE_STATE_LABEL[step.state]}
          </span>
          <span class="text-sm text-ink-soft">
            {step.minutes} 分钟 · {step.operator || '未填执刀人'} · {step.planDate ? `${step.planDate}（${weekdayLabel(step.planDate)}）` : '待排'}
          </span>

          <div class="ml-auto flex flex-wrap gap-1">
            <button class="gb-btn" onclick={() => void move(step, -1)} title="上移">↑</button>
            <button class="gb-btn" onclick={() => void move(step, 1)} title="下移">↓</button>
            <button class="gb-btn" onclick={() => void advanceCarve(step.id)}>推进状态</button>
            <button class="gb-btn" onclick={() => openEdit(step)}>编辑</button>
            <button class="gb-btn-danger" onclick={() => (pendingDelete = step)}>删除</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <p class="text-xs text-ink-soft">
    状态推进顺序：未开始 → 进行中 → 已完成；某印稿全部工序完成时，会把所属印石状态回写为「已刻」。
    刀法顺序或时长改动后，后续未完工工序自动顺延到下一个有余额的工作日，已刻完的照旧；
    两个页签同时保存时，先确认的安排生效，后提交者保留草稿并可看到被占时段。
  </p>
</div>

{#if dialogOpen}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-lg rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="mb-3 text-lg text-ink">{editing ? `编辑第 ${editing.seq} 道工序` : '新增刻制工序'}</h3>
      <div class="space-y-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="gb-label">工序序号</span>
            <input class="gb-input" type="number" min="1" bind:value={draft.seq} />
          </label>
          <label class="block">
            <span class="gb-label">刀法</span>
            <select class="gb-input" bind:value={draft.knifeMethod}>
              {#each KNIFE_METHOD_OPTIONS as item (item.value)}
                <option value={item.value}>{item.label}</option>
              {/each}
            </select>
          </label>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="gb-label">时长（分钟）</span>
            <input class="gb-input" type="number" min="1" bind:value={draft.minutes} />
          </label>
          <label class="block">
            <span class="gb-label">执刀人</span>
            <input class="gb-input" bind:value={draft.operator} placeholder="如：顾墨" />
          </label>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="gb-label">计划日（留空进入待排区）</span>
            <input class="gb-input" type="date" bind:value={draft.planDate} />
          </label>
          <label class="block">
            <span class="gb-label">状态</span>
            <select class="gb-input" bind:value={draft.state}>
              {#each CARVE_STATE_OPTIONS as item (item.value)}
                <option value={item.value}>{item.label}</option>
              {/each}
            </select>
          </label>
        </div>
        {#if capacityHint}
          <p class="text-xs text-ink-soft">{capacityHint}</p>
        {/if}
        {#if saveError}
          <p class="rounded-lg border border-seal/40 bg-seal/10 px-3 py-2 text-xs text-seal">{saveError}</p>
        {/if}
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (dialogOpen = false)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void submit()}>保存</button>
      </div>
    </div>
  </div>
{/if}

{#if pendingDelete}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
    <div class="w-full max-w-md rounded-xl border border-line bg-paper-light p-5 shadow-xl">
      <h3 class="text-lg text-ink">删除工序</h3>
      <p class="mt-2 text-sm text-ink-soft">删除第 {pendingDelete.seq} 道「{KNIFE_METHOD_LABEL[pendingDelete.knifeMethod]}」后，其余工序会自动重编号。</p>
      <div class="mt-5 flex justify-end gap-2">
        <button class="gb-btn" onclick={() => (pendingDelete = null)}>取消</button>
        <button class="gb-btn-primary" onclick={() => void confirmDelete()}>确认删除</button>
      </div>
    </div>
  </div>
{/if}
