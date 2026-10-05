<script lang="ts">
  /**
   * /carve 刻制工序看板 + 周排期
   * 上半部分为全局周排期（按执刀人 × 计划日核算每日容量，周末不排工）与待排区；
   * 下半部分按印稿列出刀法步骤、拖拽/上下移排序、逐条标记完成；全部完成即回写印石为已刻。
   * 保存工序时校验当日容量，超出即拒绝并保留草稿；顺序或时长改动后未完工工序自动顺延。
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
    applyReschedule,
    batchUpdateCarves,
    carves,
    carvesOfDesign,
    generateStandardSequence,
    loadCarves,
    nextSeq,
    removeCarve,
    reorderCarves,
    saveCarveWithCheck,
  } from '$lib/stores/carveStore';
  import { currentDesignId, designs, setCurrentDesign } from '$lib/stores/designStore';
  import { stones } from '$lib/stores/stoneStore';
  import {
    CARVE_STATE_COLOR,
    CARVE_STATE_LABEL,
    CARVE_STATE_OPTIONS,
    DAILY_CAPACITY_MINUTES,
    KNIFE_METHOD_COLOR,
    KNIFE_METHOD_LABEL,
    KNIFE_METHOD_OPTIONS,
    createEmptyCarveDraft,
    type Carve,
    type CarveDraft,
    type CarveState,
    type KnifeMethod,
  } from '$lib/types/carve';
  import {
    addDays,
    capacityLeft,
    suggestPlanDate,
    todayStr,
    weekDays,
  } from '$lib/utils/schedule';
  import { DESIGN_STYLE_LABEL } from '$lib/types/design';

  const { progressByDesign, totals } = useCarveProgress();
  const queryValues = $derived(parseQuery(router.querystring ?? ''));

  const activeDesignId = $derived($currentDesignId ?? $designs[0]?.id ?? '');
  const activeDesign = $derived($designs.find((design) => design.id === activeDesignId) ?? null);
  const stoneName = $derived(
    stones ? ($stones.find((stone) => stone.id === activeDesign?.stoneId)?.name ?? '—') : '—',
  );

  const designMap = $derived(new Map($designs.map((design) => [design.id, design])));

  function designLabel(designId: string): string {
    return designMap.get(designId)?.sealText ?? '（印稿已删除）';
  }

  const steps = $derived(
    carvesOfDesign(activeDesignId).filter((carve) => {
      const keyword = firstValue(queryValues, 'kw').trim();
      const methods = (queryValues.knifeMethod ?? []) as KnifeMethod[];
      const states = (queryValues.state ?? []) as CarveState[];
      if (keyword.length > 0 && !`${carve.operator}${carve.minutes}${carve.planDate}`.includes(keyword)) return false;
      if (methods.length > 0 && !methods.includes(carve.knifeMethod)) return false;
      if (states.length > 0 && !states.includes(carve.state)) return false;
      return true;
    }),
  );

  const progress = $derived(progressOfDesign($progressByDesign, activeDesignId));

  /* ------------------------------ 周排期 ------------------------------ */

  let weekOffset = $state(0);
  let notice = $state('');

  const weekAnchor = $derived(addDays(todayStr(), weekOffset * 7));
  const days = $derived(weekDays(weekAnchor));
  const weekRangeLabel = $derived(days.length === 7 ? `${days[0]?.date} ~ ${days[6]?.date}` : '');

  /** 计划日 → 当日工序（按执刀人、序号排序） */
  const carvesByDate = $derived.by(() => {
    const map = new Map<string, Carve[]>();
    for (const carve of $carves) {
      if (!carve.planDate) continue;
      const list = map.get(carve.planDate) ?? [];
      list.push(carve);
      map.set(carve.planDate, list);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) => a.operator.localeCompare(b.operator, 'zh-Hans-CN') || a.seq - b.seq || a.createdAt - b.createdAt,
      );
    }
    return map;
  });

  /** 计划日 →（执刀人 → 已占分钟数） */
  const usageByDate = $derived.by(() => {
    const map = new Map<string, Map<string, number>>();
    for (const carve of $carves) {
      if (!carve.planDate) continue;
      const dayMap = map.get(carve.planDate) ?? new Map<string, number>();
      const key = carve.operator || '未填';
      dayMap.set(key, (dayMap.get(key) ?? 0) + carve.minutes);
      map.set(carve.planDate, dayMap);
    }
    return map;
  });

  /** 待排区：未完工且未排期的工序 */
  const backlog = $derived(
    $carves
      .filter((carve) => !carve.planDate && carve.state !== 'done')
      .sort((a, b) => a.designId.localeCompare(b.designId) || a.seq - b.seq),
  );

  function showNotice(text: string): void {
    notice = text;
    setTimeout(() => (notice = ''), 2600);
  }

  async function manualReschedule(): Promise<void> {
    const moved = await applyReschedule();
    await loadCarves();
    showNotice(moved > 0 ? `已顺延 ${moved} 道未完工工序到有余额的工作日` : '排期无需调整');
  }

  /* ------------------------------ 对话框 ------------------------------ */

  let dialogOpen = $state(false);
  let editing = $state<Carve | null>(null);
  let draft = $state<CarveDraft>(createEmptyCarveDraft('', 1));
  let saveError = $state('');
  let conflictSlots = $state<Carve[]>([]);
  let pendingDelete = $state<Carve | null>(null);
  let selectedIds = $state<string[]>([]);
  let dragId = $state('');

  /** 对话框内实时容量提示（以当前缓存估算，最终以保存时实时校验为准） */
  const draftCapacityLeft = $derived(
    draft.planDate && draft.operator.trim()
      ? capacityLeft($carves, draft.operator.trim(), draft.planDate, editing?.id ?? '')
      : null,
  );

  function resetDialogState(): void {
    saveError = '';
    conflictSlots = [];
  }

  function openCreate(): void {
    if (!activeDesignId) return;
    editing = null;
    draft = createEmptyCarveDraft(activeDesignId, nextSeq(activeDesignId));
    resetDialogState();
    dialogOpen = true;
  }

  function openEdit(carve: Carve, prefillPlanDate = ''): void {
    editing = carve;
    draft = {
      designId: carve.designId,
      seq: carve.seq,
      knifeMethod: carve.knifeMethod,
      minutes: carve.minutes,
      operator: carve.operator,
      planDate: prefillPlanDate || carve.planDate,
      state: carve.state,
    };
    resetDialogState();
    dialogOpen = true;
  }

  /** 从待排区发起排期：预填一个有余额的工作日 */
  function scheduleBacklog(carve: Carve): void {
    openEdit(carve, suggestPlanDate($carves, carve.operator, carve.minutes));
  }

  async function submit(): Promise<void> {
    saveError = '';
    conflictSlots = [];
    const result = await saveCarveWithCheck({ ...draft }, editing);
    if (!result.ok) {
      // 拒绝保存：草稿与被占时段保留在对话框中，不覆盖先确认的安排
      saveError = result.message;
      conflictSlots = result.occupied;
      return;
    }
    editing = null;
    dialogOpen = false;
    selectedIds = [];
  }

  /* ------------------------------ 既有动作 ------------------------------ */

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
      <h2 class="text-xl tracking-wide text-ink">刻制工序看板</h2>
      <p class="mt-1 text-sm text-ink-soft">
        工序按执刀人与计划日排入周排期；同一执刀人每日容量 {DAILY_CAPACITY_MINUTES} 分钟，超出即拒绝保存，缺口留待排区。
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
    <StatBadge label="全局完成率" value={`${$totals.percent}%`} percent={$totals.percent} tone="ink" />
  </div>

  <section class="gb-panel space-y-3">
    <header class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 class="text-base text-ink">周排期</h3>
        <p class="text-xs text-ink-soft">{weekRangeLabel} · 周末不排工 · 点击工序卡片可编辑</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="gb-btn" onclick={() => (weekOffset -= 1)}>‹ 上一周</button>
        <button class="gb-btn" onclick={() => (weekOffset = 0)}>本周</button>
        <button class="gb-btn" onclick={() => (weekOffset += 1)}>下一周 ›</button>
        <button class="gb-btn" title="未完工工序容量不足或计划日过期时，顺延到下一个有余额的工作日" onclick={() => void manualReschedule()}>
          顺延重排
        </button>
      </div>
    </header>
    {#if notice}
      <div class="rounded-xl border border-jade/40 bg-jade/10 px-3 py-2 text-xs text-jade">{notice}</div>
    {/if}
    <div class="overflow-x-auto">
      <div class="grid min-w-[980px] grid-cols-7 gap-2">
        {#each days as day (day.date)}
          {@const dayCarves = carvesByDate.get(day.date) ?? []}
          {@const dayUsage = usageByDate.get(day.date)}
          <div
            class="rounded-xl border px-2 py-2 {day.isToday ? 'border-seal/50 bg-seal/5' : 'border-line'} {day.workday
              ? ''
              : 'bg-black/[0.03]'}"
          >
            <header class="mb-1 flex items-center justify-between text-xs">
              <span class="font-semibold text-ink">{day.weekLabel}</span>
              <span class="text-ink-soft">{day.label}{day.workday ? '' : ' · 休'}</span>
            </header>
            {#if dayUsage}
              <div class="mb-1 space-y-1">
                {#each [...dayUsage.entries()] as [operator, used] (operator)}
                  <div>
                    <div class="flex justify-between text-[11px] text-ink-soft">
                      <span>{operator}</span>
                      <span>{used}/{DAILY_CAPACITY_MINUTES}′</span>
                    </div>
                    <div class="h-1 rounded bg-black/10">
                      <div
                        class="h-1 rounded {used > DAILY_CAPACITY_MINUTES ? 'bg-seal' : 'bg-jade'}"
                        style="width:{Math.min(100, Math.round((used / DAILY_CAPACITY_MINUTES) * 100))}%"
                      ></div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
            <div class="space-y-1">
              {#each dayCarves as carve (carve.id)}
                <button
                  type="button"
                  class="block w-full rounded-lg border border-line bg-paper-light px-2 py-1 text-left text-[11px] leading-tight transition hover:border-seal/50"
                  style="border-left:3px solid {KNIFE_METHOD_COLOR[carve.knifeMethod]}"
                  title="{designLabel(carve.designId)} · 第 {carve.seq} 道 {KNIFE_METHOD_LABEL[carve.knifeMethod]}"
                  onclick={() => openEdit(carve)}
                >
                  <span class="block truncate text-ink">
                    {designLabel(carve.designId)}·{carve.seq} {KNIFE_METHOD_LABEL[carve.knifeMethod]}
                  </span>
                  <span class="block text-ink-soft">
                    {carve.operator || '未填'} · {carve.minutes}′ · {CARVE_STATE_LABEL[carve.state]}
                  </span>
                </button>
              {:else}
                <p class="py-1 text-center text-[11px] text-ink-soft/60">{day.workday ? '—' : ''}</p>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </section>

  {#if backlog.length > 0}
    <section class="gb-panel space-y-2">
      <header class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-base text-ink">待排区（{backlog.length}）</h3>
        <span class="text-xs text-ink-soft">容量缺口或尚未安排计划日的未完工工序在此等候</span>
      </header>
      <div class="space-y-1">
        {#each backlog as carve (carve.id)}
          <div class="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2 text-sm">
            <span
              class="gb-tag"
              style="color:{KNIFE_METHOD_COLOR[carve.knifeMethod]};border-color:{KNIFE_METHOD_COLOR[carve.knifeMethod]}66"
            >
              {KNIFE_METHOD_LABEL[carve.knifeMethod]}
            </span>
            <span class="text-ink">{designLabel(carve.designId)} · 第 {carve.seq} 道</span>
            <span class="text-ink-soft">{carve.minutes} 分钟 · {carve.operator || '未填执刀人'}</span>
            <span
              class="gb-tag"
              style="color:{CARVE_STATE_COLOR[carve.state]};border-color:{CARVE_STATE_COLOR[carve.state]}66"
            >
              {CARVE_STATE_LABEL[carve.state]}
            </span>
            <div class="ml-auto flex gap-1">
              <button class="gb-btn" onclick={() => scheduleBacklog(carve)}>排期</button>
              <button class="gb-btn" onclick={() => openEdit(carve)}>编辑</button>
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <FilterBar
    keyword={firstValue(queryValues, 'kw')}
    placeholder="搜索执刀人 / 时长 / 计划日…"
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
        ? '可一键生成标准刀法序列（冲刀 → 切刀 → 双刀 → 修整），也可手动逐条新增。'
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
            {step.minutes} 分钟 · {step.operator || '未填执刀人'} · {step.planDate || '待排'}
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
    状态推进顺序：未开始 → 进行中 → 已完成；某印稿全部工序完成时，会把所属印石状态回写为「已刻」。刀法顺序或时长改动后，后续未完工工序自动顺延到下一个有余额的工作日，已刻完的照旧。
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
        {#if draftCapacityLeft !== null}
          <p class="text-xs {draftCapacityLeft < draft.minutes ? 'text-seal' : 'text-ink-soft'}">
            {draft.operator.trim()} 在 {draft.planDate} 当日剩余容量 {draftCapacityLeft} / {DAILY_CAPACITY_MINUTES} 分钟
            {draftCapacityLeft < draft.minutes ? '，本工序排入将超出容量' : ''}
          </p>
        {/if}
        {#if saveError}
          <div class="rounded-xl border border-seal/40 bg-seal/10 px-3 py-2 text-xs text-seal">{saveError}</div>
        {/if}
        {#if conflictSlots.length > 0}
          <div class="rounded-xl border border-seal/40 bg-seal/5 px-3 py-2 text-xs">
            <p class="mb-1 font-semibold text-seal">该时段已被以下工序占用：</p>
            <ul class="space-y-0.5 text-ink-soft">
              {#each conflictSlots as slot (slot.id)}
                <li>
                  {designLabel(slot.designId)} · 第 {slot.seq} 道 {KNIFE_METHOD_LABEL[slot.knifeMethod]}
                  {slot.minutes} 分钟（{CARVE_STATE_LABEL[slot.state]}）
                </li>
              {/each}
            </ul>
          </div>
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
