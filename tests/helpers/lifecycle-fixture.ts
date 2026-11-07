import { eq } from 'drizzle-orm'
import {
  lifecycleDefinitions,
  lifecycleKinds,
} from '../../src/lib/npi/lifecycle'
import { today } from '../../src/lib/npi/domain'
import type { LifecycleKind } from '../../src/lib/npi/lifecycle'
export const processPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n',
)
export function lifecyclePayload(kind: LifecycleKind, result = 'pass') {
  return {
    kind,
    title: `${lifecycleDefinitions[kind].label}验证`,
    plannedDate: today(),
    performedDate: today(),
    result,
    data: {
      fields: {
        ...Object.fromEntries(
          lifecycleDefinitions[kind].fields.map((f) => [
            f.key,
            `${f.label}已核对，依据记录编号 TEST-01。`,
          ]),
        ),
        summary: '按约定指标完成验证，结果与基线一致。',
        nextAction: '分析偏差并复测，保留原记录。',
        followUpDate: today(),
      },
      measurements:
        kind === 'test'
          ? [
              {
                item: '转速',
                requirement: '1450±25',
                measured: '1460',
                unit: 'r/min',
                verdict: 'pass',
              },
            ]
          : [],
    },
  }
}
// Focused pre-existing evidence for tests of delivery, routing and unrelated guards.
// Lifecycle submission, attachments and failure paths are exercised via real APIs in lifecycle.test.ts.
export async function seedLifecycleForLegacyTests(
  db: any,
  s: any,
  projectId: string,
) {
  const [p] = await db
    .select()
    .from(s.npiProjects)
    .where(eq(s.npiProjects.programId, projectId))
  for (const kind of lifecycleKinds) {
    const payload = lifecyclePayload(kind)
    await db
      .insert(s.npiLifecycleRecords)
      .values({
        ...payload,
        id: crypto.randomUUID(),
        programId: projectId,
        status: 'submitted',
        submittedAt: new Date(),
        createdBy: p.technicalOwnerId,
        updatedBy: p.technicalOwnerId,
      })
  }
}
