// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import catalog from '../../docs/sop/catalog.json'
import { NpiError } from '../lib/npi/domain'
import type { GuideCatalog } from '../lib/npi/guide-types'

export function guideCatalog(): GuideCatalog {
  return { guides: catalog.map(({ assets: _assets, ...guide }) => guide) }
}

async function documentResponse(
  path: string,
  name: string,
  type: string,
  inline = false,
) {
  let bytes: Buffer
  try {
    bytes = await readFile(resolve('docs', path))
  } catch {
    throw new NpiError(
      'DOCUMENT_NOT_FOUND',
      '文件暂不可用，请联系管理员核对部署文件',
      503,
    )
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': type,
      'Content-Length': String(bytes.length),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="HD-PLM-guide.${path.split('.').at(-1)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export const processGuideFile = () =>
  documentResponse(
    '设计部新品跟踪管理程序.docx',
    '设计部新品跟踪管理程序.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )

function findGuide(id: string) {
  const guide = catalog.find((item) => item.id === id)
  if (!guide) throw new NpiError('DOCUMENT_NOT_FOUND', '未找到这份 SOP', 404)
  return guide
}

export function sopDownload(id: string, format: string) {
  const guide = findGuide(id)
  if (format !== 'pptx' && format !== 'pdf')
    throw new NpiError('DOCUMENT_NOT_FOUND', '不支持此文件格式', 404)
  return documentResponse(
    `sop/${guide.id}.${format}`,
    `${guide.department}软件操作SOP.${format}`,
    format === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  )
}

export function sopPage(id: string, page: string) {
  const guide = findGuide(id)
  if (!/^[1-9]\d*$/.test(page) || Number(page) > guide.pages.length)
    throw new NpiError('DOCUMENT_NOT_FOUND', '未找到这一页', 404)
  return documentResponse(
    `sop/${guide.id}/${page}.webp`,
    `${guide.department}-第${page}页.webp`,
    'image/webp',
    true,
  )
}
