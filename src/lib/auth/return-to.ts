// SPDX-License-Identifier: AGPL-3.0-or-later
/** Only return to known application pages; never follow a URL supplied by a host. */
export function safeReturnTo(value: string | null | undefined): string {
  if (
    !value ||
    /[\\\u0000-\u0020]/.test(value) ||
    !value.startsWith('/') ||
    value.startsWith('//')
  )
    return '/npi'
  try {
    const url = new URL(value, 'https://workspace.invalid')
    if (
      url.origin !== 'https://workspace.invalid' ||
      !['/npi', '/npi/trash', '/account', '/accounts'].includes(url.pathname)
    )
      return '/npi'
    return url.pathname + url.search + url.hash
  } catch {
    return '/npi'
  }
}
export function loginReturnTo(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
): string {
  const target = new URLSearchParams(location.search).get('redirect')
  return safeReturnTo(
    target ?? location.pathname + location.search + location.hash,
  )
}
