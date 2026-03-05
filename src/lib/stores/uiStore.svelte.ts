const STORAGE_KEY = 'ui-state';

export type SidePanel = 'queue' | 'lyrics' | null;
export type PanelType = SidePanel; // backwards compat alias
export type CompactVisMode = 'spectrum' | 'oscilloscope' | 'vu' | 'off';
export type FullscreenVisMode = 'spectrum' | 'oscilloscope' | 'vu' | 'starfield' | 'milkdrop';

interface UiState {
	sidePanel: SidePanel;
	artExpanded: boolean;
	visualizerMode: CompactVisMode;
	fullscreenVisMode: FullscreenVisMode;
}

const defaults: UiState = {
	sidePanel: null,
	artExpanded: false,
	visualizerMode: 'spectrum',
	fullscreenVisMode: 'spectrum'
};

function load(): UiState {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			return { ...defaults, ...parsed };
		}
	} catch {
		// ignore corrupt data
	}
	return { ...defaults };
}

const initial = load();

let sidePanel = $state<SidePanel>(initial.sidePanel);
let artExpanded = $state(initial.artExpanded);
let artFullscreen = $state(false); // never persisted
let visualizerMode = $state<CompactVisMode>(initial.visualizerMode);
let fullscreenVisualizer = $state(false); // never persisted
let fullscreenVisMode = $state<FullscreenVisMode>(initial.fullscreenVisMode);

// Mobile state (never persisted)
let sidebarOpen = $state(false);
let queueExpanded = $state(false);

function save() {
	localStorage.setItem(STORAGE_KEY, JSON.stringify({ sidePanel, artExpanded, visualizerMode, fullscreenVisMode }));
}

// Side panel
export function getSidePanel(): SidePanel {
	return sidePanel;
}

export function toggleQueue() {
	sidePanel = sidePanel === 'queue' ? null : 'queue';
	save();
}

export function toggleLyrics() {
	sidePanel = sidePanel === 'lyrics' ? null : 'lyrics';
	save();
}

export function setSidePanel(tab: 'queue' | 'lyrics') {
	sidePanel = tab;
	save();
}

export function closeSidePanel() {
	sidePanel = null;
	save();
}

// Album art
export function getArtExpanded(): boolean {
	return artExpanded;
}

export function toggleArtExpanded() {
	artExpanded = !artExpanded;
	save();
}

export function setArtExpanded(value: boolean) {
	artExpanded = value;
	save();
}

export function getArtFullscreen(): boolean {
	return artFullscreen;
}

export function setArtFullscreen(value: boolean) {
	artFullscreen = value;
	// intentionally not persisted
}

// Create Playlist modal
let showCreatePlaylist = $state(false);

export function getShowCreatePlaylist(): boolean {
	return showCreatePlaylist;
}

export function toggleCreatePlaylist() {
	showCreatePlaylist = !showCreatePlaylist;
}

export function closeCreatePlaylist() {
	showCreatePlaylist = false;
}

// Visualizer mode (compact seek bar)
export function getVisualizerMode(): CompactVisMode {
	return visualizerMode;
}

export function setVisualizerMode(mode: CompactVisMode) {
	visualizerMode = mode;
	save();
}

const visModeCycle: CompactVisMode[] = ['off', 'spectrum', 'oscilloscope', 'vu'];
export function cycleVisualizerMode() {
	const idx = visModeCycle.indexOf(visualizerMode);
	visualizerMode = visModeCycle[(idx + 1) % visModeCycle.length];
	save();
}

// Fullscreen visualizer
export function getFullscreenVisualizer(): boolean {
	return fullscreenVisualizer;
}

export function setFullscreenVisualizer(value: boolean) {
	fullscreenVisualizer = value;
}

export function getFullscreenVisMode(): FullscreenVisMode {
	return fullscreenVisMode;
}

export function setFullscreenVisMode(mode: FullscreenVisMode) {
	fullscreenVisMode = mode;
	save();
}

// Mobile sidebar
export function getSidebarOpen(): boolean {
	return sidebarOpen;
}

export function setSidebarOpen(value: boolean) {
	sidebarOpen = value;
}

export function toggleSidebar() {
	sidebarOpen = !sidebarOpen;
}

// Mobile queue expanded (fullscreen)
export function getQueueExpanded(): boolean {
	return queueExpanded;
}

export function setQueueExpanded(value: boolean) {
	queueExpanded = value;
}

export function toggleQueueExpanded() {
	queueExpanded = !queueExpanded;
}

// Playlist version — bumped when playlists are created/deleted to trigger re-fetches
let playlistVersion = $state(0);

export function getPlaylistVersion(): number {
	return playlistVersion;
}

export function bumpPlaylistVersion() {
	playlistVersion++;
}
