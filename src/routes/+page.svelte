<script lang="ts">
	import Card from '$lib/components/ui/Card.svelte';
	import HorizontalScroller from '$lib/components/ui/HorizontalScroller.svelte';
	import TrackRow from '$lib/components/ui/TrackRow.svelte';
	import { Capability } from '$lib/backends/types';
	import type { Hub, Track, Album, Artist } from '$lib/backends/types';
	import { getBackend, hasCapability } from '$lib/stores/backendStore.svelte';
	import { formatDuration } from '$lib/utils/format';
	import { playTracksNow } from '$lib/stores/unifiedQueue.svelte';
	import { playCurrentItem } from '$lib/stores/playerStore.svelte';

	let hubs = $state<Hub[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	function greeting(): string {
		const h = new Date().getHours();
		if (h < 12) return 'Good morning';
		if (h < 18) return 'Good afternoon';
		return 'Good evening';
	}

	function isTrack(item: Track | Album | Artist): item is Track {
		return 'duration' in item && 'artistName' in item && !('trackCount' in item);
	}

	function isAlbum(item: Track | Album | Artist): item is Album {
		return 'trackCount' in item;
	}

	function isArtist(item: Track | Album | Artist): item is Artist {
		return !isTrack(item) && !isAlbum(item);
	}

	function playSingleTrack(track: Track) {
		playTracksNow([track], 0);
		playCurrentItem();
	}

	async function playAlbum(album: Album) {
		const backend = getBackend();
		if (!backend?.getAlbumTracks) return;
		const tracks = await backend.getAlbumTracks(album.id);
		if (tracks.length === 0) return;
		playTracksNow(tracks, 0);
		playCurrentItem();
	}

	async function playArtist(artist: Artist) {
		const backend = getBackend();
		if (!backend?.getArtistTopTracks) return;
		const tracks = await backend.getArtistTopTracks(artist.id);
		if (tracks.length === 0) return;
		playTracksNow(tracks, 0);
		playCurrentItem();
	}

	$effect(() => {
		const backend = getBackend();
		if (!backend || !backend.supports(Capability.Hubs)) {
			loading = false;
			return;
		}

		loading = true;
		error = null;

		backend.getHubs!().then(
			(data) => {
				hubs = data;
				loading = false;
			},
			(err) => {
				error = err?.message ?? 'Failed to load';
				loading = false;
			}
		);
	});
</script>

<section>
	<div class="relative mb-6">
		<div
			class="pointer-events-none absolute -top-6 -left-6 h-32 w-96 rounded-full bg-accent/[0.04] blur-3xl"
		></div>
		<h1 class="relative text-2xl font-bold md:text-3xl">{greeting()}</h1>
	</div>

	{#if !hasCapability(Capability.Hubs)}
		<div class="flex flex-col items-center justify-center gap-4 py-24 text-text-muted">
			<p class="text-lg">No backend connected</p>
			<a href="/settings/backends" class="text-sm text-accent hover:underline"
				>Connect a backend to get started</a
			>
		</div>
	{:else if error}
		<div class="flex flex-col items-center justify-center gap-2 py-24 text-text-muted">
			<p class="text-lg">Something went wrong</p>
			<p class="text-sm">{error}</p>
		</div>
	{:else}
		{#each hubs as hub}
			{#if hub.layout === 'list'}
				{@const tracks = hub.items.filter(isTrack)}
				<div class="mb-8">
					<h2 class="mb-3 text-lg font-semibold text-text-primary">{hub.title}</h2>
					<div class="space-y-0.5">
						{#each tracks.slice(0, 10) as track, i}
							<TrackRow
								number={i + 1}
								title={track.title}
								artist={track.artistName}
								artistId={track.artistId}
								album={track.albumName || undefined}
								albumId={track.albumId || undefined}
								duration={formatDuration(track.duration)}
								onclick={() => playSingleTrack(track)}
							/>
						{/each}
					</div>
				</div>
			{:else if hub.layout === 'scroller'}
				<HorizontalScroller title={hub.title} loading={loading}>
					{#each hub.items as item}
						{#if isTrack(item)}
							<div class="shrink-0" style:width="var(--scroller-item-width)">
								<a href="/album/{item.albumId}" class="contents">
									<Card
										title={item.title}
										subtitle={item.artistName}
										imageUrl={item.thumb ?? undefined}
										compact
										onplay={() => playSingleTrack(item)}
									/>
								</a>
							</div>
						{:else if isAlbum(item)}
							<div class="shrink-0" style:width="var(--scroller-item-width)">
								<a href="/album/{item.id}" class="contents">
									<Card
										title={item.title}
										subtitle={item.artistName}
										imageUrl={item.thumb ?? undefined}
										compact
										onplay={() => playAlbum(item)}
									/>
								</a>
							</div>
						{:else if isArtist(item)}
							<div class="shrink-0" style:width="var(--scroller-item-width)">
								<a href="/artist/{item.id}" class="contents">
									<Card
										title={item.title}
										subtitle={item.genres[0] ?? ''}
										imageUrl={item.thumb ?? undefined}
										rounded
										compact
										onplay={() => playArtist(item)}
									/>
								</a>
							</div>
						{/if}
					{/each}
				</HorizontalScroller>
			{:else if hub.layout === 'hero'}
				<div class="mb-8">
					<h2 class="mb-3 text-lg font-semibold text-text-primary">{hub.title}</h2>
					<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 md:gap-4">
						{#each hub.items.slice(0, 3) as item}
							{@const href = isArtist(item) ? `/artist/${item.id}` : isAlbum(item) ? `/album/${item.id}` : isTrack(item) && item.albumId ? `/album/${item.albumId}` : '#'}
							{@const subtitle = isTrack(item) ? item.artistName : isAlbum(item) ? item.artistName : isArtist(item) ? (item.genres[0] ?? '') : ''}
							<a {href} class="group relative overflow-hidden rounded-lg bg-bg-elevated">
								<div class="aspect-[16/9] w-full overflow-hidden">
									{#if isTrack(item) && item.thumb}
										<img src={item.thumb} alt="" class="h-full w-full object-cover transition-transform group-hover:scale-105" />
									{:else if isAlbum(item) && item.thumb}
										<img src={item.thumb} alt="" class="h-full w-full object-cover transition-transform group-hover:scale-105" />
									{:else if isArtist(item) && item.thumb}
										<img src={item.thumb} alt="" class="h-full w-full object-cover transition-transform group-hover:scale-105" />
									{:else}
										<div class="flex h-full w-full items-center justify-center bg-bg-highlight text-text-muted">No image</div>
									{/if}
								</div>
								<div class="p-3">
									<p class="truncate font-medium text-text-primary">{item.title}</p>
									<p class="truncate text-sm text-text-muted">{subtitle}</p>
								</div>
							</a>
						{/each}
					</div>
				</div>
			{:else if hub.layout === 'pills'}
				<div class="mb-8">
					<h2 class="mb-3 text-lg font-semibold text-text-primary">{hub.title}</h2>
					<div class="flex flex-wrap gap-2">
						{#each hub.items as item}
							<span class="rounded-full bg-bg-elevated px-3 py-1.5 text-sm text-text-primary hover:bg-bg-highlight transition-colors cursor-pointer">
								{item.title}
							</span>
						{/each}
					</div>
				</div>
			{/if}
		{/each}

		{#if loading && hubs.length === 0}
			{#each ['Top Tracks', 'Top Albums', 'Top Artists'] as title}
				<div class="mb-6">
					<h2 class="mb-3 text-lg font-semibold text-text-primary">{title}</h2>
					<div class="flex gap-3">
						{#each Array(6) as _}
							<div class="shrink-0 animate-pulse rounded-md bg-bg-elevated" style:width="160px">
								<div class="aspect-square w-full rounded-t-md bg-bg-highlight"></div>
								<div class="space-y-2 p-2">
									<div class="h-3 w-3/4 rounded bg-bg-highlight"></div>
									<div class="h-2.5 w-1/2 rounded bg-bg-highlight"></div>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/each}
		{/if}
	{/if}
</section>
