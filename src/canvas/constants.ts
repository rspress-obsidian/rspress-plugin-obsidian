/**
 * Default `sandbox` of a link card's website preview. It leaves out
 * `allow-same-origin`: with both it and `allow-scripts`, a framed page served
 * from the site's own origin could remove its sandbox. Node-free: the build
 * plugin and the browser components share it.
 */
export const DEFAULT_IFRAME_SANDBOX = "allow-scripts allow-popups";
