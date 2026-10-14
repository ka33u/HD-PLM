// SPDX-License-Identifier: AGPL-3.0-or-later
export function projectTitle(project: {
  name: string
  motorModel: string
  profile?: { motorType?: string }
}) {
  const name = project.profile?.motorType || project.name
  return name === project.motorModel ? name : `${project.motorModel} · ${name}`
}
