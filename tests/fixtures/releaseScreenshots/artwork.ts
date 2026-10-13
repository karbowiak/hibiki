/** Original, code-native art; no copied covers or personal library content. */
export function demoArtwork(index: number, landscape = false): string {
  const palettes = [
    ["#13364a", "#72cbd4", "#e2b786"],
    ["#342540", "#c08cdd", "#eba276"],
    ["#26383b", "#9fc7a0", "#eee0a6"],
    ["#462c32", "#eb9886", "#dfcc9f"],
    ["#1c2945", "#829fde", "#d8b4ba"],
    ["#343022", "#d2bd67", "#b5d4c4"],
  ]
  const [dark, light, accent] = palettes[index % palettes.length],
    width = landscape ? 1440 : 640,
    height = landscape ? 810 : 640
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="sky" x2="1" y2="1"><stop stop-color="${dark}"/><stop offset="1" stop-color="${light}"/></linearGradient><radialGradient id="sun"><stop stop-color="${accent}"/><stop offset="1" stop-color="${accent}" stop-opacity=".3"/></radialGradient><pattern id="lines" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M0 24L24 0" stroke="white" stroke-opacity=".08"/></pattern></defs><rect width="${width}" height="${height}" fill="url(#sky)"/><circle cx="${width * 0.68}" cy="${height * 0.31}" r="${height * 0.24}" fill="url(#sun)"/><path d="M0 ${height * 0.64}Q${width * 0.25} ${height * 0.34} ${width * 0.5} ${height * 0.69}T${width} ${height * 0.51}V${height}H0Z" fill="${dark}" opacity=".7"/><path d="M0 ${height * 0.78}Q${width * 0.36} ${height * 0.55} ${width * 0.68} ${height * 0.82}T${width} ${height * 0.68}V${height}H0Z" fill="${dark}" opacity=".65"/><rect width="${width}" height="${height}" fill="url(#lines)"/><g fill="none" stroke="${accent}" stroke-opacity=".55"><circle cx="${width * 0.3}" cy="${height * 0.4}" r="${height * 0.17}"/><circle cx="${width * 0.3}" cy="${height * 0.4}" r="${height * 0.2}"/><path d="M${width * 0.14} ${height * 0.14}H${width * 0.4}M${width * 0.14} ${height * 0.14}V${height * 0.2}"/></g></svg>`
}
