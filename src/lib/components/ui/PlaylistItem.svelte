<script lang="ts">
	import { Music } from 'lucide-svelte';
	import { getAppearance } from '$lib/stores/configStore.svelte';

	interface Props {
		name: string;
		imageUrl?: string;
		href?: string;
		active?: boolean;
		onclick?: () => void;
	}

	let { name, imageUrl, href = '#', active = false, onclick }: Props = $props();
	let compact = $derived(getAppearance().compactMode);
</script>

<a
	{href}
	onclick={() => onclick?.()}
	class="flex items-center gap-3 px-4 {compact ? 'py-1' : 'py-1.5'} text-sm transition-colors hover:text-text-primary hover:bg-accent-tint-hover {active ? 'text-text-primary bg-accent-tint-subtle' : 'text-text-secondary'}"
>
	<div class="flex {compact ? 'h-6 w-6' : 'h-8 w-8'} shrink-0 items-center justify-center rounded bg-gradient-to-br from-bg-highlight via-bg-elevated to-bg-highlight overflow-hidden">
		{#if imageUrl}
			<img src={imageUrl} alt={name} class="h-full w-full object-cover" />
		{:else}
			<Music size={compact ? 12 : 14} class="text-text-muted" />
		{/if}
	</div>
	<span class="truncate">{name}</span>
</a>
