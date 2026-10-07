// SPDX-License-Identifier: AGPL-3.0-or-later
export function projectTitle(project: { name: string; motorModel: string }) {
  return project.name === project.motorModel
    ? project.name
    : `${project.motorModel} · ${project.name}`
}
