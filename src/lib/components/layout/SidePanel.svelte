<script lang="ts">
	import { X, GripVertical, Podcast, Radio, Trash2, ChevronUp, ChevronDown } from 'lucide-svelte';
	import { fly } from 'svelte/transition';
	import { getSidePanel, setSidePanel, closeSidePanel, getQueueExpanded, setQueueExpanded } from '$lib/stores/uiStore.svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import CachedImage from '$lib/components/ui/CachedImage.svelte';
	import Slider from '$lib/components/ui/Slider.svelte';
	import {
		getCurrentItem,
		getItems,
		getCurrentIndex,
		toDisplay,
		getActiveMediaType,
		reorderQueue,
		setCurrentIndex,
		clearQueue
	} from '$lib/stores/unifiedQueue.svelte';
	import { playCurrentItem, getState, stopPlayback } from '$lib/stores/playerStore.svelte';
	import { lyricsData } from '$lib/data/lyrics';
	import { getLyricsState, loadTrackOffset, updateOffset } from '$lib/stores/lyricsOffsetStore.svelte';
	import { getAppearance } from '$lib/stores/configStore.svelte';
	import { formatDuration } from '$lib/utils/format';

	import type { SidePanel } from '$lib/stores/uiStore.svelte';

	let compact = $derived(getAppearance().compactMode);

	let activePanel = $derived(getSidePanel());
	let queueExpanded = $derived(getQueueExpanded());

	// Unified queue
	let currentItem = $derived(getCurrentItem());
	let currentDisplay = $derived(currentItem ? toDisplay(currentItem) : null);
	let mediaType = $derived(getActiveMediaType());
	let allItems = $derived(getItems());
	let curIndex = $derived(getCurrentIndex());
	let upNext = $derived(allItems.slice(curIndex + 1));
	let upNextCount = $derived(upNext.length);
	let playState = $derived(getState());

	function playFromQueue(index: number) {
		setCurrentIndex(index);
		playCurrentItem();
	}

	function handleNowPlayingClick() {
		// If stopped (e.g. radio was stopped), re-play the current item
		if (playState === 'stopped' && currentItem) {
			playCurrentItem();
		}
	}

	function handleClearQueue() {
		stopPlayback();
		clearQueue();
	}

	let activeLine = $state(9);

	$effect(() => {
		loadTrackOffset('demo-track');
	});

	const tabs: { id: Exclude<SidePanel, null>; label: string }[] = [
		{ id: 'queue', label: 'Queue' },
		{ id: 'lyrics', label: 'Lyrics' }
	];

	// --- Queue drag-to-reorder state ---
	const DRAG_THRESHOLD = 5; // px movement before entering drag mode
	let pendingIndex = $state(-1); // index of item being pressed (not yet dragging)
	let pendingStartY = $state(0); // Y position at pointerdown
	let dragIndex = $state(-1);
	let overIndex = $state(-1);
	let dragY = $state(0);
	let dragOffsetY = $state(0);
	let listEl = $state<HTMLDivElement | undefined>(undefined);
	let scrollContainerEl = $state<HTMLDivElement | undefined>(undefined);

	let draggedItem = $derived(dragIndex >= 0 && dragIndex < upNext.length ? upNext[dragIndex] : null);
	let draggedDisplay = $derived(draggedItem ? toDisplay(draggedItem) : null);
	let listRect = $derived.by(() => {
		if (dragIndex >= 0 && scrollContainerEl) {
			return scrollContainerEl.getBoundingClientRect();
		}
		return null;
	});

	function onPointerDown(e: PointerEvent, index: number) {
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture(e.pointerId);
		pendingIndex = index;
		pendingStartY = e.clientY;
		dragOffsetY = e.clientY - target.getBoundingClientRect().top;
	}

	function onPointerMove(e: PointerEvent) {
		// Not pressed on anything
		if (pendingIndex < 0 && dragIndex < 0) return;

		// If still in pending state, check if we exceeded threshold
		if (pendingIndex >= 0 && dragIndex < 0) {
			if (Math.abs(e.clientY - pendingStartY) >= DRAG_THRESHOLD) {
				// Promote to drag
				dragIndex = pendingIndex;
				overIndex = pendingIndex;
				dragY = e.clientY;
				pendingIndex = -1;
			}
			return;
		}

		// Active drag
		if (dragIndex < 0 || !listEl || !scrollContainerEl) return;
		dragY = e.clientY;

		const y = e.clientY;
		const rows = listEl.children;
		let closest = dragIndex;
		let closestDist = Infinity;
		for (let i = 0; i < rows.length; i++) {
			const rect = rows[i].getBoundingClientRect();
			const mid = rect.top + rect.height / 2;
			const dist = Math.abs(y - mid);
			if (dist < closestDist) {
				closestDist = dist;
				closest = i;
			}
		}
		overIndex = closest;

		const containerRect = scrollContainerEl.getBoundingClientRect();
		const edgeZone = 40;
		if (y < containerRect.top + edgeZone) {
			scrollContainerEl.scrollTop -= 5;
		} else if (y > containerRect.bottom - edgeZone) {
			scrollContainerEl.scrollTop += 5;
		}
	}

	function onPointerUp() {
		// If still pending (no drag started), treat as click → play
		if (pendingIndex >= 0 && dragIndex < 0) {
			const absIndex = curIndex + 1 + pendingIndex;
			playFromQueue(absIndex);
			pendingIndex = -1;
			return;
		}

		// End drag
		if (dragIndex < 0) return;
		if (dragIndex !== overIndex) {
			const fromAbs = curIndex + 1 + dragIndex;
			const toAbs = curIndex + 1 + overIndex;
			reorderQueue(fromAbs, toAbs);
		}
		dragIndex = -1;
		overIndex = -1;
		pendingIndex = -1;
	}

	// --- Lyrics timing offset (IndexedDB-backed) ---
	let lyricsState = $derived(getLyricsState());
	let lyricsOffset = $derived(lyricsState.offset);
	let offsetDisplay = $derived(() => {
		const sec = lyricsOffset / 1000;
		const sign = sec >= 0 ? '+' : '';
		return `${sign}${sec.toFixed(1)}s`;
	});

	function onTimingWheel(e: WheelEvent) {
		e.preventDefault();
		const delta = e.deltaY < 0 ? 100 : -100;
		updateOffset(Math.max(-5000, Math.min(5000, lyricsOffset + delta)));
	}

	function onTimingInput(e: Event) {
		updateOffset(+(e.target as HTMLInputElement).value);
	}

	function resetTiming() {
		updateOffset(0);
	}

	function typeIcon(type: string) {
		if (type === 'podcast') return Podcast;
		if (type === 'radio') return Radio;
		return null;
	}

	function handleClose() {
		setQueueExpanded(false);
		closeSidePanel();
	}
</script>

<!-- Mobile: fullscreen overlay -->
<aside
	class="
		max-md:fixed max-md:inset-0 max-md:z-50 max-md:flex max-md:flex-col max-md:bg-bg-surface
		md:flex md:w-[350px] md:shrink-0 md:flex-col md:border-l md:border-border md:bg-bg-surface md:shadow-[inset_2px_0_8px_rgba(0,0,0,0.3)]
	"
	transition:fly={{ x: 350, duration: 200 }}
>
	<!-- Tab header -->
	<div class="flex items-center border-b border-border px-4">
		<div class="flex flex-1 gap-4">
			{#each tabs as tab}
				<button
					type="button"
					class="py-3 text-sm font-semibold transition-colors {activePanel === tab.id
						? 'border-b-2 border-accent text-text-primary'
						: 'text-text-muted hover:text-text-secondary'}"
					onclick={() => setSidePanel(tab.id)}
				>
					{tab.label}
				</button>
			{/each}
		</div>
		<!-- Mobile: expand/collapse toggle -->
		<span class="md:hidden">
			<IconButton
				icon={queueExpanded ? ChevronDown : ChevronUp}
				size={16}
				label={queueExpanded ? 'Collapse' : 'Expand'}
				onclick={() => setQueueExpanded(!queueExpanded)}
			/>
		</span>
		<IconButton icon={X} size={16} label="Close panel" onclick={handleClose} />
	</div>

	<!-- Queue content -->
	{#if activePanel === 'queue'}
		<!-- Now Playing -->
		<div class="px-4 py-3">
			<p class="mb-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">
				Now Playing
			</p>
			{#if currentDisplay}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="flex items-center gap-3 rounded-lg border border-accent/10 p-3 {playState === 'stopped' ? 'cursor-pointer hover:border-accent/30' : ''}"
					style="background: var(--color-accent-tint-subtle)"
					onclick={handleNowPlayingClick}
					onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleNowPlayingClick(); }}
					role={playState === 'stopped' ? 'button' : undefined}
					tabindex={playState === 'stopped' ? 0 : undefined}
				>
					{#if currentDisplay.artwork}
						<CachedImage src={currentDisplay.artwork} alt="" class="{compact ? 'h-8 w-8' : 'h-10 w-10'} max-md:h-12 max-md:w-12 shrink-0 rounded object-cover" />
					{:else}
						{@const Icon = typeIcon(mediaType ?? '') ?? Podcast}
						<div class="{compact ? 'h-8 w-8' : 'h-10 w-10'} max-md:h-12 max-md:w-12 flex shrink-0 items-center justify-center rounded bg-bg-highlight">
							<Icon size={16} class="text-text-muted" />
						</div>
					{/if}
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium text-accent max-md:text-base">{currentDisplay.title}</p>
						<p class="truncate text-xs text-text-secondary max-md:text-sm">{currentDisplay.subtitle}</p>
					</div>
					{#if currentDisplay.durationMs > 0}
						<span class="text-xs tabular-nums text-text-muted">{formatDuration(currentDisplay.durationMs)}</span>
					{/if}
					{#if currentDisplay.isStream}
						<span class="shrink-0 rounded bg-red-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none text-red-400">LIVE</span>
					{/if}
				</div>
			{:else}
				<p class="text-xs text-text-muted">Nothing playing</p>
			{/if}
		</div>

		<!-- Up Next -->
		<div class="flex items-center justify-between px-4 pb-1">
			<p class="text-[10px] font-medium uppercase tracking-wider text-text-muted">
				Next Up · {upNextCount} item{upNextCount !== 1 ? 's' : ''}
			</p>
			{#if upNextCount > 0}
				<button
					type="button"
					class="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-secondary"
					onclick={handleClearQueue}
					title="Clear queue"
				>
					<Trash2 size={10} />
					Clear
				</button>
			{/if}
		</div>
		<div class="flex-1 overflow-y-auto px-4 pb-3 max-md:pb-20" bind:this={scrollContainerEl}>
			<div class="flex flex-col gap-0.5" bind:this={listEl}>
				{#each upNext as queueItem, i (toDisplay(queueItem).id + '-' + i)}
					{@const d = toDisplay(queueItem)}
					{@const isDragging = dragIndex === i}
					{@const isOver = dragIndex >= 0 && overIndex === i && dragIndex !== i}
					{@const absIndex = curIndex + 1 + i}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="group relative flex cursor-grab items-center gap-3 rounded-lg border px-2 {compact ? 'py-1' : 'py-1.5'} max-md:py-2 transition-all select-none active:cursor-grabbing
							{isDragging
							? 'border-accent/20 bg-accent/5 opacity-30'
							: 'border-transparent hover:border-border hover:bg-accent-tint-hover'}"
						style="touch-action: none"
						onpointerdown={(e) => onPointerDown(e, i)}
						onpointermove={onPointerMove}
						onpointerup={onPointerUp}
						onpointercancel={onPointerUp}
					>
						{#if isOver && overIndex < dragIndex}
							<div
								class="absolute -top-[1px] right-2 left-2 h-0.5 rounded-full bg-accent"
							></div>
						{/if}
						<div
							class="flex shrink-0 items-center text-text-muted/40 transition-colors group-hover:text-text-muted"
						>
							<GripVertical size={14} />
						</div>
						{#if d.artwork}
							<CachedImage src={d.artwork} alt="" class="{compact ? 'h-8 w-8' : 'h-10 w-10'} max-md:h-10 max-md:w-10 shrink-0 rounded object-cover" />
						{:else}
							{@const TypeIcon = typeIcon(queueItem.type)}
							<div class="{compact ? 'h-8 w-8' : 'h-10 w-10'} max-md:h-10 max-md:w-10 flex shrink-0 items-center justify-center rounded bg-gradient-to-br from-bg-highlight via-bg-elevated to-bg-highlight">
								{#if TypeIcon}
									<TypeIcon size={14} class="text-text-muted" />
								{/if}
							</div>
						{/if}
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm text-text-primary">{d.title}</p>
							<p class="truncate text-xs text-text-secondary">{d.subtitle}</p>
						</div>
						{#if d.durationMs > 0}
							<span class="text-xs tabular-nums text-text-muted">{formatDuration(d.durationMs)}</span>
						{/if}
						{#if d.isStream}
							<span class="shrink-0 rounded bg-red-500/20 px-1 py-0.5 text-[8px] font-bold uppercase leading-none text-red-400">LIVE</span>
						{/if}
						{#if isOver && overIndex >= dragIndex}
							<div
								class="absolute -bottom-[1px] right-2 left-2 h-0.5 rounded-full bg-accent"
							></div>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<!-- Floating ghost card -->
		{#if draggedDisplay && listRect}
			<div
				class="pointer-events-none fixed z-50 flex items-center gap-3 rounded-lg border border-accent/40 bg-bg-elevated px-2 py-1.5 shadow-xl shadow-black/50"
				style="top: {dragY - dragOffsetY}px; left: {listRect.left}px; width: {listRect.width}px; transform: scale(1.02);"
			>
				<div class="flex shrink-0 items-center text-accent">
					<GripVertical size={14} />
				</div>
				{#if draggedDisplay.artwork}
					<CachedImage src={draggedDisplay.artwork} alt="" class="h-10 w-10 shrink-0 rounded object-cover" />
				{:else}
					<div class="h-10 w-10 shrink-0 rounded bg-bg-highlight"></div>
				{/if}
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium text-text-primary">{draggedDisplay.title}</p>
					<p class="truncate text-xs text-text-secondary">{draggedDisplay.subtitle}</p>
				</div>
				{#if draggedDisplay.durationMs > 0}
					<span class="text-xs tabular-nums text-text-muted">{formatDuration(draggedDisplay.durationMs)}</span>
				{/if}
			</div>
		{/if}
	{/if}

	<!-- Lyrics content -->
	{#if activePanel === 'lyrics'}
		<div class="mx-4 mt-3 rounded-lg border border-accent/10 p-3" style="background: var(--color-accent-tint-subtle)">
			<p class="truncate text-sm font-bold text-text-primary max-md:text-base">{lyricsData.title}</p>
			<p class="truncate text-xs text-text-secondary max-md:text-sm">{lyricsData.artist}</p>
		</div>

		<div class="flex-1 overflow-y-auto px-6 py-4 max-md:pb-20">
			<div class="flex flex-col gap-2">
				{#each lyricsData.lines as line, i}
					{#if line === ''}
						<div class="h-4"></div>
					{:else}
						<button
							type="button"
							class="cursor-pointer rounded-lg px-2 -mx-2 text-left text-2xl font-bold transition-all duration-300 {i ===
							activeLine
								? 'text-accent drop-shadow-[0_0_8px_var(--color-glow-accent)]'
								: 'text-text-muted/40 hover:text-text-muted/60 hover:bg-accent-tint-hover'}"
							onclick={() => (activeLine = i)}
						>
							{line}
						</button>
					{/if}
				{/each}
			</div>
		</div>

		<!-- Timing offset bar -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="flex items-center gap-3 border-t border-border bg-bg-surface px-4 py-3 max-md:pb-20" onwheel={onTimingWheel}>
			<span class="shrink-0 text-[10px] font-medium uppercase tracking-wider text-text-muted">
				Timing
			</span>
			<Slider value={lyricsOffset} oninput={onTimingInput} min={-5000} max={5000} step={100} class="flex-1" />
			<button
				type="button"
				class="shrink-0 text-xs tabular-nums text-text-muted transition-colors hover:text-text-secondary"
				ondblclick={resetTiming}
				title="Double-click to reset"
			>
				{offsetDisplay()}
			</button>
		</div>
	{/if}
</aside>
