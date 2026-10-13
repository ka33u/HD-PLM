// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated UI regression: real components, with an explicitly scoped task API fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'

test('production tasks retain local, department and cross-project parts in a single list', async () => {
  const actor = {
    id: 'owner',
    role: 'manufacturing',
    departmentId: 'production',
    collaboratorIds: ['peer'],
  }
  const part = (
    id: string,
    programId = 'local',
    ownerId = 'owner',
    completed = false,
  ) => ({
    id,
    programId,
    ownerId,
    name: id,
    ownerName: ownerId,
    sourceType: 'ERP_BOM',
    trackingType: 'material',
    trackingEnabled: true,
    affectsKit: true,
    qty: '1',
    unit: '件',
    specification: '规格',
    projectName: programId,
    projectCode: programId,
    motorModel: 'YE5 55kW',
    currentNpiStage: 'manufacturing',
    requiredDate: '2026-11-20',
    currentCommittedDate: null,
    actualCompleteDate: completed ? '2026-11-18' : null,
    status: completed ? 'completed' : 'pending_reply',
    bomReference: { materialCode: id, rowNo: 6, versionNo: 1, current: true },
    version: 0,
  })
  const items = [
    part('本项目部件'),
    part('同部门部件', 'local', 'peer'),
    part('跨项目部件', 'external'),
    part('已完成部件', 'local', 'owner', true),
    {
      ...part('待复核部件'),
      bomReference: {
        materialCode: 'OLD-BOM',
        rowNo: 7,
        versionNo: 1,
        current: false,
      },
    },
  ]
  const nodes = ['process', 'tooling', 'kit', 'assembly'].map(
    (trackingType) => ({
      ...part(trackingType),
      sourceType: 'MANUFACTURING',
      trackingType,
    }),
  )
  const dashboard = {
    projects: [
      {
        id: 'local',
        code: 'PR-001',
        name: '当前项目',
        motorModel: 'YE5',
        manufacturingOwnerId: actor.id,
        currentNpiStage: 'manufacturing',
        items: nodes,
      },
    ],
    todayActivity: { day: '2026-11-18' },
  }
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { NpiPreparationBoard } from './src/components/npi/NpiModuleViews';
        import { NpiAssignedMaterials } from './src/components/npi/NpiAssignedMaterials';
        import './src/components/npi/npi.css';
        const mode = new URLSearchParams(location.search).get('mode');
        const dashboard = ${JSON.stringify(dashboard)};
        const actor = ${JSON.stringify(actor)};
        createRoot(document.getElementById('app')).render(<div className="npi-app"><main className="npi-main"><div className="npi-content">
          {mode !== 'purchasing' ? <NpiAssignedMaterials actorId={actor.id} revision={dashboard} managedProjectIds={mode === 'dashboard' ? ['local'] : []} /> :
          <NpiPreparationBoard dashboard={dashboard} actor={{...actor, role: mode === 'admin' ? 'admin' : actor.role}} mode="purchasing" onOpen={() => {}} />}
        </div></main></div>);
      `,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    outdir: '/tmp/hd-preparation-bundle',
    entryNames: 'app',
    jsx: 'automatic',
    platform: 'browser',
    target: 'es2022',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  let apiReads = 0
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/api/v1/npi/workbench/materials')) {
      apiReads++
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({ actorId: actor.id, today: '2026-11-18', items }),
      )
      return
    }
    const file = result.outputFiles.find(
      (f) => request.url === '/' + f.path.split('/').at(-1),
    )
    response.setHeader(
      'content-type',
      file?.path.endsWith('.css')
        ? 'text/css'
        : file
          ? 'text/javascript'
          : 'text/html',
    )
    response.end(
      file
        ? file.contents
        : '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="app"></div><script type="module" src="/app.js"></script></html>',
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const root = `http://127.0.0.1:${address.port}`
  const browser = await chromium.launch({
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    headless: true,
  })
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
    })
    await page.goto(root)
    const materials = page.getByRole('region', { name: '我的生产任务' })
    await expect(materials.locator('tbody tr')).toHaveCount(4)
    for (const name of ['本项目部件', '同部门部件', '跨项目部件'])
      await expect(
        materials.locator('tbody tr').filter({ hasText: name }),
      ).toHaveCount(1)
    const staleRow = materials
      .locator('tbody tr')
      .filter({ hasText: '待复核部件' })
    await expect(staleRow).toContainText('待BOM复核，请项目负责人处理')
    await expect(
      staleRow.getByRole('button', { name: '回复日期' }),
    ).toHaveCount(0)
    await expect(
      staleRow.getByRole('button', { name: '确认完成' }),
    ).toHaveCount(0)
    await expect(
      staleRow.getByRole('button', { name: '承诺历史' }),
    ).toBeVisible()
    await materials.getByLabel('物料待办状态').selectOption('completed')
    await expect(materials.locator('tbody tr')).toHaveCount(1)
    await expect(materials.locator('tbody tr')).toContainText('已完成部件')
    await materials.getByLabel('物料待办状态').selectOption('all')
    await expect(materials.locator('tbody tr')).toHaveCount(5)
    await materials.getByLabel('搜索我的物料').fill('同部门')
    await expect(materials.locator('tbody tr')).toHaveCount(1)
    await materials.getByLabel('搜索我的物料').fill('')
    mkdirSync('runtime/test-evidence', { recursive: true })
    await page.screenshot({
      path: resolve('runtime/test-evidence/preparation-parts-desktop.png'),
      fullPage: true,
    })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    )
    await page.screenshot({
      path: resolve('runtime/test-evidence/preparation-parts-mobile.png'),
      fullPage: true,
    })
    await page.goto(root + '/?mode=dashboard')
    await expect(
      page.getByRole('region', { name: '我的生产任务' }).locator('tbody tr'),
    ).toHaveCount(1)
    await expect(
      page.getByRole('region', { name: '我的生产任务' }),
    ).toContainText('跨项目部件')
    const reads = apiReads
    await page.goto(root + '/?mode=purchasing')
    await expect(
      page.getByRole('region', { name: '采购物料任务' }),
    ).toBeVisible()
    assert.equal(
      apiReads,
      reads,
      'purchasing must not request production material tasks',
    )
  } finally {
    await browser.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
