<script lang="ts">
	import { untrack } from 'svelte';
	import {
		Shuffle,
		SkipBack,
		Play,
		Pause,
		SkipForward,
		Repeat,
		Repeat1,
		ListMusic,
		Mic2,
		Volume,
		Volume1,
		Volume2,
		VolumeX,
		ChevronUp,
		ChevronDown,
		Maximize2,
		X,
		Radio,
		Activity
	} from 'lucide-svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import Slider from '$lib/components/ui/Slider.svelte';
	import StarRating from '$lib/components/ui/StarRating.svelte';
	import CachedImage from '$lib/components/ui/CachedImage.svelte';
	import EQCard from '$lib/components/features/EQCard.svelte';
	import SleepTimerCard from '$lib/components/features/SleepTimerCard.svelte';
	import SeekVisualizer from '$lib/components/visualizer/SeekVisualizer.svelte';
	import FullscreenVisualizer from '$lib/components/visualizer/FullscreenVisualizer.svelte';
	import {
		toggleQueue,
		toggleLyrics,
		getSidePanel,
		getArtExpanded,
		setArtExpanded,
		getArtFullscreen,
		setArtFullscreen,
		getVisualizerMode,
		cycleVisualizerMode,
		getFullscreenVisualizer,
		setFullscreenVisualizer
	} from '$lib/stores/uiStore.svelte';
	import { getVolume, setVolume, getPlayback, getRepeatMode, cycleRepeatMode, getShuffled, setShuffled } from '$lib/stores/configStore.svelte';
	import { getCurrentItem, toDisplay, getActiveMediaType, hasNext, hasPrevious, getQueueCount, getItems, getCurrentIndex, shuffleQueue, unshuffleQueue, clearQueue } from '$lib/stores/unifiedQueue.svelte';
	import { getHasLyrics } from '$lib/stores/lyricsAvailableStore.svelte';
	import { getSleepTimer, formatRemaining } from '$lib/stores/sleepTimerStore.svelte';
	import { getAppearance } from '$lib/stores/configStore.svelte';
	import {
		getState,
		getPosition,
		getDuration,
		togglePlayback,
		playCurrentItem,
		skipNext,
		skipPrevious,
		seekTo,
		syncConfig,
		stopPlayback
	} from '$lib/stores/playerStore.svelte';
	import { getNowPlaying } from '$lib/stores/radioStore.svelte';

	let compact = $derived(getAppearance().compactMode);

	// Unified queue state
	let item = $derived(getCurrentItem());
	let display = $derived(item ? toDisplay(item) : null);
	let mediaType = $derived(getActiveMediaType());

	// Player state
	let playState = $derived(getState());
	let pos = $derived(getPosition());
	let dur = $derived(getDuration());

	// Radio ICY metadata
	let radioNowPlaying = $derived(getNowPlaying());

	// Derived UI
	let PlayPauseIcon = $derived(playState === 'playing' ? Pause : Play);
	let progress = $derived(dur > 0 ? (pos / dur) * 100 : 0);

	function formatTime(ms: number): string {
		const totalSec = Math.floor(ms / 1000);
		const m = Math.floor(totalSec / 60);
		const s = totalSec % 60;
		return `${m}:${s.toString().padStart(2, '0')}`;
	}

	function onProgressInput(e: Event) {
		const val = +(e.target as HTMLInputElement).value;
		seekTo((val / 100) * dur);
	}

	function handlePlayPause() {
		if (mediaType === 'radio') {
			if (playState === 'playing') {
				stopPlayback();
			} else {
				playCurrentItem();
			}
		} else {
			togglePlayback();
		}
	}

	// Long-press play/pause (1s) → stop + clear queue
	let longPressTimer: ReturnType<typeof setTimeout> | null = null;
	let longPressFired = $state(false);

	function onPlayPointerDown() {
		longPressFired = false;
		longPressTimer = setTimeout(() => {
			longPressFired = true;
			stopPlayback();
			clearQueue();
		}, 1000);
	}

	function onPlayPointerUp() {
		if (longPressTimer) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
		if (!longPressFired) {
			handlePlayPause();
		}
	}

	// Reactive config sync — re-runs when volume or playback config changes
	$effect(() => {
		getVolume();
		getPlayback();
		untrack(() => syncConfig());
	});

	let volConfig = $derived(getVolume());
	let volume = $derived(volConfig.level);
	let muted = $derived(volConfig.muted);

	let activePanel = $derived(getSidePanel());
	let artExpanded = $derived(getArtExpanded());
	let fullscreen = $derived(getArtFullscreen());

	let visualizerMode = $derived(getVisualizerMode());
	let fullscreenVis = $derived(getFullscreenVisualizer());
	let visualizerEnabled = $derived(getPlayback().visualizerEnabled);
	let visActive = $derived(visualizerEnabled && visualizerMode !== 'off');

	let seekHoverPct: number | null = $state(null);

	let shuffled = $derived(getShuffled());
	let repeatMode = $derived(getRepeatMode());
	let RepeatIcon = $derived(repeatMode === 'one' ? Repeat1 : Repeat);
	let queueCount = $derived.by(() => {
		const items = getItems();
		const idx = getCurrentIndex();
		return Math.max(0, items.length - idx - 1);
	});
	let lyricsAvailable = $derived(getHasLyrics());
	let sleepTimer = $derived(getSleepTimer());
	let sleepRemaining = $derived(formatRemaining());

	function toggleShuffle() {
		if (shuffled) {
			unshuffleQueue();
			setShuffled(false);
		} else {
			shuffleQueue();
			setShuffled(true);
		}
	}

	let VolumeIcon = $derived.by(() => {
		if (muted || volume === 0) return VolumeX;
		if (volume <= 33) return Volume;
		if (volume <= 66) return Volume1;
		return Volume2;
	});

	function onVolumeInput(e: Event) {
		const val = +(e.target as HTMLInputElement).value;
		if (muted && val > 0) {
			setVolume({ level: val, muted: false });
		} else {
			setVolume({ level: val });
		}
	}

	function toggleMute() {
		if (muted) {
			setVolume({ muted: false, level: volConfig.preMuteLevel });
		} else {
			setVolume({ preMuteLevel: volume, muted: true, level: 0 });
		}
	}

	function onVolumeWheel(e: WheelEvent) {
		e.preventDefault();
		const delta = e.deltaY < 0 ? 5 : -5;
		const val = Math.max(0, Math.min(100, volume + delta));
		if (muted && val > 0) {
			setVolume({ level: val, muted: false });
		} else {
			setVolume({ level: val });
		}
	}
</script>

<svelte:window
	onkeydown={fullscreen || fullscreenVis ? (e) => {
		if (e.key === 'Escape') {
			if (fullscreenVis) setFullscreenVisualizer(false);
			else if (fullscreen) setArtFullscreen(false);
		}
	} : undefined}
/>

<div class="h-px bg-gradient-to-r from-transparent via-overlay-medium to-transparent"></div>

<!-- Desktop player bar -->
<footer
	class="hidden h-(--spacing-player) items-center bg-bg-elevated pr-4 pl-4 md:grid"
	style="grid-template-columns: 1fr minmax(400px, 2fr) 1fr;"
>
	<!-- Left: Track info + album art -->
	<div class="flex min-w-0 items-center gap-3">
		{#if artExpanded}
			<div class="shrink-0" style="width: calc(var(--spacing-sidebar) - 16px);"></div>
		{/if}
		{#if !artExpanded}
			<a
				href="/album/1"
				class="group relative block {compact ? 'h-10 w-10' : 'h-14 w-14'} shrink-0 overflow-hidden rounded bg-gradient-to-br from-bg-highlight via-bg-elevated to-bg-highlight"
			>
				<CachedImage
					src={display?.artwork}
					alt=""
					class="h-full w-full object-cover"
					lazy={false}
				/>
				<!-- Hover overlay buttons -->
				<div
					class="absolute inset-0 flex items-end justify-between bg-black/0 p-1 opacity-0 transition-opacity group-hover:bg-black/40 group-hover:opacity-100"
				>
					<button
						type="button"
						class="flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
						onclick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							setArtExpanded(true);
						}}
						aria-label="Expand"
					>
						<ChevronUp size={12} />
					</button>
					<button
						type="button"
						class="flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
						onclick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							setArtFullscreen(true);
						}}
						aria-label="Fullscreen"
					>
						<Maximize2 size={10} />
					</button>
				</div>
			</a>
		{/if}
		<div class="ml-1 min-w-0">
			{#if mediaType === 'radio' && display}
				{#if radioNowPlaying?.title}
					<div class="flex items-center gap-1.5">
						<p class="truncate text-sm font-medium text-text-primary">{radioNowPlaying.title}</p>
						<span class="shrink-0 rounded bg-red-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none text-red-400">LIVE</span>
					</div>
					<p class="truncate text-xs text-text-secondary">{radioNowPlaying.artist ? `${radioNowPlaying.artist} — ` : ''}{display.title}</p>
				{:else}
					<div class="flex items-center gap-1.5">
						<p class="truncate text-sm font-medium text-text-primary">{display.title}</p>
						<span class="shrink-0 rounded bg-red-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none text-red-400">LIVE</span>
					</div>
					<p class="truncate text-xs text-text-secondary">{display.subtitle}</p>
				{/if}
			{:else if display}
				<p class="truncate text-sm font-medium text-text-primary">{display.title}</p>
				<p class="truncate text-xs text-text-secondary">{display.subtitle}</p>
			{:else}
				<p class="truncate text-sm font-medium text-text-primary">No track playing</p>
				<p class="truncate text-xs text-text-secondary">&nbsp;</p>
			{/if}
		</div>
		{#if mediaType === 'track'}
			<StarRating class="ml-2" />
		{/if}
	</div>

	<!-- Center: Controls + progress (always dead center via grid) -->
	<div class="flex flex-col items-center gap-1">
		<div class="flex items-center {compact ? 'gap-2' : 'gap-3'}">
			{#if mediaType === 'radio'}
				<IconButton icon={Radio} size={16} label="Radio" active={true} />
			{:else if mediaType === 'track'}
				<IconButton icon={Shuffle} size={16} label="Shuffle" active={shuffled} onclick={toggleShuffle} />
			{/if}
			{#if mediaType !== 'radio'}
				<IconButton icon={SkipBack} size={18} label="Previous" onclick={skipPrevious} />
			{/if}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<span
				onpointerdown={onPlayPointerDown}
				onpointerup={onPlayPointerUp}
				onpointercancel={onPlayPointerUp}
			>
				<IconButton icon={PlayPauseIcon} size={20} label={playState === 'playing' ? 'Pause' : 'Play'} variant="play" />
			</span>
			{#if mediaType !== 'radio'}
				<IconButton icon={SkipForward} size={18} label="Next" onclick={skipNext} />
			{/if}
			{#if mediaType === 'track'}
				<IconButton icon={RepeatIcon} size={16} label="Repeat" active={repeatMode !== 'off'} onclick={cycleRepeatMode} />
			{/if}
		</div>
		<div class="flex w-full items-center {compact ? 'gap-1.5' : 'gap-2'}">
			{#if visActive && display?.isStream}
				<span class="w-16 text-right text-xs tabular-nums text-text-muted">&nbsp;</span>
				<div class="relative flex-1 select-none">
					<SeekVisualizer progressPct={0} hoverPct={null} mode={visualizerMode} />
				</div>
				<span class="w-16 text-xs tabular-nums text-text-muted">&nbsp;</span>
			{:else if visActive}
				<span class="w-16 text-right text-xs tabular-nums text-text-muted">{formatTime(pos)}</span>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="relative flex-1 cursor-pointer select-none"
					onmousemove={(e) => {
						const rect = e.currentTarget.getBoundingClientRect();
						seekHoverPct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
					}}
					onmouseleave={() => (seekHoverPct = null)}
				>
					<SeekVisualizer progressPct={progress} hoverPct={seekHoverPct} mode={visualizerMode} />
					<input
						type="range"
						min={0}
						max={100}
						step={0.1}
						value={progress}
						oninput={onProgressInput}
						class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
						aria-label="Seek"
					/>
				</div>
				<span class="w-16 text-xs tabular-nums text-text-muted">{formatTime(dur)}</span>
			{:else if display?.isStream}
				<span class="w-16 text-right text-xs tabular-nums text-text-muted">&nbsp;</span>
				<div class="flex-1 h-1 rounded-full bg-white/10"></div>
				<span class="w-16 text-xs tabular-nums text-text-muted">&nbsp;</span>
			{:else}
				<span class="w-16 text-right text-xs tabular-nums text-text-muted">{formatTime(pos)}</span>
				<Slider value={progress} oninput={onProgressInput} class="flex-1" />
				<span class="w-16 text-xs tabular-nums text-text-muted">{formatTime(dur)}</span>
			{/if}
		</div>
	</div>

	<!-- Right: Volume + controls -->
	<div class="flex items-center justify-end gap-2">
		<div class="relative">
			<IconButton
				icon={ListMusic}
				size={18}
				label="Queue"
				active={activePanel === 'queue'}
				onclick={toggleQueue}
			/>
			{#if queueCount > 0}
				<span class="pointer-events-none absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold leading-none text-bg-base">
					{queueCount}
				</span>
			{/if}
		</div>
		<IconButton
			icon={Mic2}
			size={18}
			label="Lyrics"
			active={activePanel === 'lyrics' || lyricsAvailable}
			onclick={toggleLyrics}
		/>
		<EQCard />
		{#if visualizerEnabled}
			<IconButton
				icon={Activity}
				size={18}
				label="Visualizer ({visualizerMode})"
				active={visActive}
				onclick={cycleVisualizerMode}
			/>
			<IconButton
				icon={Maximize2}
				size={18}
				label="Fullscreen visualizer"
				onclick={() => setFullscreenVisualizer(true)}
			/>
		{/if}
		<div class="relative">
			<SleepTimerCard />
			{#if sleepTimer.selected && sleepRemaining}
				<span class="pointer-events-none absolute -bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap text-[9px] tabular-nums font-medium text-accent">
					{sleepRemaining}
				</span>
			{/if}
		</div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="group relative ml-1 flex items-center gap-1.5" onwheel={onVolumeWheel}>
			<!-- Volume tooltip -->
			<div
				class="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 rounded border border-border bg-bg-elevated px-2 py-0.5 text-[10px] tabular-nums text-text-secondary opacity-0 shadow-lg transition-opacity group-hover:opacity-100"
			>
				{volume}%
			</div>
			<button
				type="button"
				class="flex items-center justify-center text-text-secondary transition-colors hover:text-text-primary"
				onclick={toggleMute}
				aria-label="Toggle mute"
			>
				<VolumeIcon size={18} />
			</button>
			<Slider value={volume} oninput={onVolumeInput} class="w-24" />
		</div>
	</div>
</footer>

<!-- Mobile player bar -->
<footer class="flex flex-col bg-bg-elevated md:hidden">
	<!-- Progress bar (thin, full-width at top) -->
	<div class="relative h-1 w-full bg-white/10">
		{#if !display?.isStream && dur > 0}
			<div class="absolute inset-y-0 left-0 bg-accent" style="width: {progress}%"></div>
			<input
				type="range"
				min={0}
				max={100}
				step={0.1}
				value={progress}
				oninput={onProgressInput}
				class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
				aria-label="Seek"
			/>
		{/if}
	</div>
	<!-- Main mobile controls row -->
	<div class="flex items-center gap-2 px-3 py-2">
		<!-- Artwork -->
		<div class="h-10 w-10 shrink-0 overflow-hidden rounded bg-gradient-to-br from-bg-highlight via-bg-elevated to-bg-highlight">
			<CachedImage
				src={display?.artwork}
				alt=""
				class="h-full w-full object-cover"
				lazy={false}
			/>
		</div>

		<!-- Track info -->
		<div class="min-w-0 flex-1">
			{#if mediaType === 'radio' && display}
				{#if radioNowPlaying?.title}
					<div class="flex items-center gap-1.5">
						<p class="truncate text-sm font-medium text-text-primary">{radioNowPlaying.title}</p>
						<span class="shrink-0 rounded bg-red-500/20 px-1 py-0.5 text-[8px] font-bold uppercase leading-none text-red-400">LIVE</span>
					</div>
					<p class="truncate text-xs text-text-secondary">{display.title}</p>
				{:else}
					<div class="flex items-center gap-1.5">
						<p class="truncate text-sm font-medium text-text-primary">{display.title}</p>
						<span class="shrink-0 rounded bg-red-500/20 px-1 py-0.5 text-[8px] font-bold uppercase leading-none text-red-400">LIVE</span>
					</div>
					<p class="truncate text-xs text-text-secondary">{display.subtitle}</p>
				{/if}
			{:else if display}
				<p class="truncate text-sm font-medium text-text-primary">{display.title}</p>
				<p class="truncate text-xs text-text-secondary">{display.subtitle}</p>
			{:else}
				<p class="truncate text-sm text-text-muted">No track playing</p>
			{/if}
		</div>

		<!-- Mobile playback controls -->
		<div class="flex shrink-0 items-center gap-1">
			{#if mediaType !== 'radio'}
				<IconButton icon={SkipBack} size={18} label="Previous" onclick={skipPrevious} />
			{/if}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<span
				onpointerdown={onPlayPointerDown}
				onpointerup={onPlayPointerUp}
				onpointercancel={onPlayPointerUp}
			>
				<IconButton icon={PlayPauseIcon} size={22} label={playState === 'playing' ? 'Pause' : 'Play'} variant="play" />
			</span>
			{#if mediaType !== 'radio'}
				<IconButton icon={SkipForward} size={18} label="Next" onclick={skipNext} />
			{/if}
			<div class="relative">
				<IconButton
					icon={ListMusic}
					size={18}
					label="Queue"
					active={activePanel === 'queue'}
					onclick={toggleQueue}
				/>
				{#if queueCount > 0}
					<span class="pointer-events-none absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[8px] font-bold leading-none text-bg-base">
						{queueCount}
					</span>
				{/if}
			</div>
		</div>
	</div>
</footer>

<!-- Expanded album art — fixed bottom-left corner (desktop only) -->
{#if artExpanded}
	<div class="fixed bottom-0 left-0 z-50 w-(--spacing-sidebar) max-md:hidden">
		<a href="/album/1" class="group relative block overflow-hidden">
			{#if display?.artwork}
				<CachedImage
					src={display.artwork}
					alt=""
					class="aspect-square w-full object-cover"
					lazy={false}
				/>
			{:else}
				<div class="aspect-square w-full bg-bg-highlight"></div>
			{/if}
			<!-- Hover overlay -->
			<div
				class="absolute inset-0 flex items-end justify-between bg-black/0 p-2 opacity-0 transition-opacity group-hover:bg-black/40 group-hover:opacity-100"
			>
				<button
					type="button"
					class="flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
					onclick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						setArtExpanded(false);
					}}
					aria-label="Collapse"
				>
					<ChevronDown size={16} />
				</button>
				<button
					type="button"
					class="flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
					onclick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						setArtFullscreen(true);
					}}
					aria-label="Fullscreen"
				>
					<Maximize2 size={14} />
				</button>
			</div>
		</a>
	</div>
{/if}

<!-- Fullscreen album art modal -->
{#if fullscreen}
	<div
		class="fixed inset-0 z-[100] flex items-center justify-center bg-black/90"
		onclick={() => setArtFullscreen(false)}
		onkeydown={(e) => e.key === 'Escape' && setArtFullscreen(false)}
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-label="Album art fullscreen"
	>
		<button
			type="button"
			class="absolute top-6 right-6 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
			onclick={() => setArtFullscreen(false)}
			aria-label="Close"
		>
			<X size={20} />
		</button>
		{#if display?.artwork}
			<button
				type="button"
				class="h-[80vh] max-h-[80vw] w-[80vw] max-w-[80vh] cursor-default overflow-hidden rounded-2xl shadow-2xl"
				onclick={(e) => e.stopPropagation()}
				aria-label="Album artwork"
			>
				<CachedImage
					src={display.artwork}
					alt=""
					class="h-full w-full object-cover"
					lazy={false}
				/>
			</button>
		{:else}
			<button
				type="button"
				class="h-[80vh] max-h-[80vw] w-[80vw] max-w-[80vh] cursor-default rounded-2xl bg-bg-highlight shadow-2xl"
				onclick={(e) => e.stopPropagation()}
				aria-label="Album artwork"
			></button>
		{/if}
	</div>
{/if}

<!-- Fullscreen visualizer overlay -->
{#if fullscreenVis}
	<FullscreenVisualizer />
{/if}
