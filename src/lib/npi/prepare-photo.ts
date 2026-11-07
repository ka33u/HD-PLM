// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_NPI_FILE_BYTES } from './file-types'
export const PHOTO_ACCEPT =
  'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
export const PHOTO_BATCH_LIMIT = 20
/** Decode through the browser so EXIF orientation is applied before resizing. */
export async function preparePhoto(file: File): Promise<File> {
  if (!file.size) throw new Error('照片为空，请重新选择')
  if (
    !/\.(jpe?g|png|webp)$/i.test(file.name) &&
    !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
  )
    throw new Error('请使用 JPG、PNG 或 WebP 照片；HEIC 请先转换为 JPG')
  if (file.size > 40 * 1024 * 1024)
    throw new Error('原照片超过40MB，请先缩小后重选')
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode().catch(() => {
      throw new Error('无法读取照片，请重新拍照或转换为 JPG')
    })
    if (
      !img.naturalWidth ||
      !img.naturalHeight ||
      img.naturalWidth * img.naturalHeight > 100_000_000
    )
      throw new Error('照片尺寸过大或无效，请缩小后重选')
    // Preserve small images and screenshots exactly; optimize camera originals.
    if (
      file.size <= 2 * 1024 * 1024 &&
      Math.max(img.naturalWidth, img.naturalHeight) <= 2560
    )
      return file
    const scale = Math.min(
      1,
      2560 / Math.max(img.naturalWidth, img.naturalHeight),
    )
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('浏览器无法处理照片，请使用较小的 JPG 文件')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    let blob: Blob | null = null
    for (const quality of [0.9, 0.8, 0.7]) {
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', quality),
      )
      if (blob && blob.size <= 2 * 1024 * 1024) break
    }
    if (!blob || blob.size > MAX_NPI_FILE_BYTES)
      throw new Error('照片处理后仍超过5MB，请缩小后重选')
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}
