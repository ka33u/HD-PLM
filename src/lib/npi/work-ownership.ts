// SPDX-License-Identifier: AGPL-3.0-or-later
// The server rebuilds this scope from active, same-role department membership.
export function ownsWork(
  actor: { id: string; collaboratorIds?: string[] } | null | undefined,
  ownerId: string,
) {
  return (
    !!actor &&
    (actor.id === ownerId || !!actor.collaboratorIds?.includes(ownerId))
  )
}
