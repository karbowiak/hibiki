<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getAppearance } from '$lib/stores/configStore.svelte';

	interface Props {
		icon: any;
		label: string;
		active?: boolean;
		href?: string;
		onclick?: (e: MouseEvent) => void;
	}

	let { icon: Icon, label, active = false, href = '#', onclick }: Props = $props();

	function handleClick(e: MouseEvent) {
		if (onclick) {
			if (!href || href === '#') e.preventDefault();
			onclick(e);
		}
	}
	let compact = $derived(getAppearance().compactMode);
</script>

<a
	{href}
	onclick={handleClick}
	class="flex items-center {compact ? 'gap-3' : 'gap-4'} px-4 {compact ? 'py-1' : 'py-2'} text-sm font-medium transition-all {active
		? 'text-text-primary border-l-2 border-accent'
		: 'text-text-secondary hover:text-text-primary hover:bg-accent-tint-hover border-l-2 border-transparent'}"
	style={active ? `background: var(--color-accent-tint-subtle)` : undefined}
>
	<Icon size={compact ? 18 : 22} strokeWidth={active ? 2.5 : 2} />
	<span>{label}</span>
</a>
