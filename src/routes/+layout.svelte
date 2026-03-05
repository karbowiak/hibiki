<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import Sidebar from '$lib/components/layout/Sidebar.svelte';
	import TopBar from '$lib/components/layout/TopBar.svelte';
	import PlayerBar from '$lib/components/layout/PlayerBar.svelte';
	import SidePanel from '$lib/components/layout/SidePanel.svelte';
	import { getSidePanel, getShowCreatePlaylist } from '$lib/stores/uiStore.svelte';
	import CreatePlaylistModal from '$lib/components/ui/CreatePlaylistModal.svelte';
	import { applyTheme } from '$lib/stores/applyTheme.svelte';
	import { scrollMemory, trackPath } from '$lib/actions/scrollMemory';
	import { page } from '$app/state';
	import { getAppearance } from '$lib/stores/configStore.svelte';
	import { restoreBackends } from '$lib/stores/backendStore.svelte';
	import { onMount } from 'svelte';

	let compact = $derived(getAppearance().compactMode);

	let { children } = $props();

	$effect(() => {
		applyTheme();
	});

	onMount(() => {
		restoreBackends();
	});

	$effect(() => {
		trackPath(page.url.pathname);
	});

	let activePanel = $derived(getSidePanel());
	let showCreatePlaylist = $derived(getShowCreatePlaylist());
	let isSettings = $derived(page.url.pathname.startsWith('/settings'));
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
</svelte:head>

<div class="flex h-screen flex-col bg-bg-base">
	<div class="flex min-h-0 flex-1">
		<Sidebar />
		<div class="relative flex min-h-0 min-w-0 flex-1 flex-col transition-all duration-200">
			<div class="absolute inset-x-0 top-0 z-30">
				<TopBar />
			</div>
			<main use:scrollMemory={'main'} class="relative flex min-h-0 flex-1 flex-col bg-bg-surface pt-(--spacing-topbar) {isSettings ? '' : compact ? 'overflow-y-auto pr-4 pb-4 pl-4' : 'overflow-y-auto max-md:px-3 max-md:pb-3 pr-6 pb-6 pl-6'}">
				<div class="{isSettings ? 'flex min-h-0 flex-1' : 'relative'}">
					{@render children()}
				</div>
			</main>
			<div class="pointer-events-none absolute inset-x-0 top-0 z-20 h-(--spacing-topbar) bg-bg-surface"></div>
		</div>
		{#if activePanel}
			<SidePanel />
		{/if}
	</div>
	<PlayerBar />
</div>

{#if showCreatePlaylist}
	<CreatePlaylistModal />
{/if}
