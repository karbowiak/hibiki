// Every explicit listening choice retires unresolved choices, even before its
// metadata arrives. Native playback generations remain owned by the player.
let selection = 0
export const capturePlaybackSelectionVersion = () => selection
export const advancePlaybackSelection = () => ++selection
