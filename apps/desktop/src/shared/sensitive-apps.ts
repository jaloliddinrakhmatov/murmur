// Apps whose text Murmur must never read, and apps where a pasted newline does something else.
// Matched by bundle id prefix, case-insensitively.

/** Terminals: a paste runs at the shell prompt. */
export const TERMINAL_APPS =
  /^(com\.apple\.Terminal|com\.googlecode\.iterm2|com\.mitchellh\.ghostty|net\.kovidgoyal\.kitty|dev\.warp\.Warp|co\.zeit\.hyper|org\.alacritty|com\.github\.wez\.wezterm|org\.tabby)/i;

export const PASSWORD_MANAGER_APPS =
  /^(com\.1password|com\.agilebits\.onepassword|com\.bitwarden\.desktop|com\.apple\.keychainaccess|com\.apple\.Passwords|com\.dashlane|com\.lastpass|com\.callpod\.keeper|ch\.protonmail\.pass|me\.proton\.pass|com\.enpass|in\.sinew\.Enpass)/i;

/** Editors and IDEs: a newline in a paste can auto-indent or run. */
export const CODE_EDITOR_APPS =
  /^(com\.microsoft\.VSCode|com\.todesktop\.230313mzl4w4u92|com\.jetbrains\.|dev\.zed\.Zed|com\.apple\.dt\.Xcode)/i;

/** Fields in these apps are never read for context or corrections. */
export function isNoReadApp(bundleId: string | null | undefined): boolean {
  const id = bundleId ?? "";
  return TERMINAL_APPS.test(id) || PASSWORD_MANAGER_APPS.test(id);
}
