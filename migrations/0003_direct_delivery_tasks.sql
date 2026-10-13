ALTER TABLE npi_tracking_items ALTER COLUMN name TYPE text;
--> statement-breakpoint
-- Preserve historical node replies and identities; only assembly becomes the whole-machine task.
UPDATE npi_tracking_items SET source_type = 'LEGACY_NODE', tracking_enabled = false, affects_kit = false, version = version + 1
WHERE source_type = 'MANUFACTURING' AND tracking_type <> 'assembly';
--> statement-breakpoint
UPDATE npi_tracking_items SET source_type = 'WHOLE_MACHINE', name = '整机完成', affects_kit = false, tracking_enabled = true, version = version + 1
WHERE source_type = 'MANUFACTURING' AND tracking_type = 'assembly';
--> statement-breakpoint
-- Previously unselected current rows now default to the manufacturing owner.
-- Unreviewed same-code history must be reconciled first, never duplicated.
UPDATE npi_tracking_items t SET tracking_enabled = true, affects_kit = true, version = t.version + 1
FROM npi_projects p, npi_bom_items b
WHERE t.program_id = p.program_id AND t.bom_item_id = b.id AND b.import_id = p.active_bom_import_id
AND p.current_npi_stage <> 'completed' AND (NOT t.tracking_enabled OR NOT t.affects_kit);
--> statement-breakpoint
UPDATE npi_tracking_items SET affects_kit = true, version = version + 1
WHERE source_type = 'EXTERNAL' AND tracking_enabled AND NOT affects_kit
AND program_id IN (SELECT program_id FROM npi_projects WHERE current_npi_stage <> 'completed');
--> statement-breakpoint
INSERT INTO npi_tracking_items (program_id, bom_item_id, source_type, tracking_type, name, specification, qty, unit, owner_id, required_date, affects_kit, tracking_enabled)
SELECT p.program_id, b.id, 'ERP_BOM', 'material', b.row->>'materialName', COALESCE(b.row->>'specification',''), b.row->>'qty', COALESCE(b.row->>'unit',''), p.manufacturing_owner_id, p.required_kit_date, true, true
FROM npi_projects p JOIN npi_bom_items b ON b.import_id=p.active_bom_import_id
WHERE p.current_npi_stage <> 'completed'
AND NOT EXISTS (SELECT 1 FROM npi_tracking_items t WHERE t.bom_item_id=b.id)
AND NOT EXISTS (SELECT 1 FROM npi_tracking_items t JOIN npi_bom_items old ON old.id=t.bom_item_id WHERE t.program_id=p.program_id AND old.import_id<>p.active_bom_import_id AND old.material_code=b.material_code AND t.actual_complete_date IS NULL AND (t.tracking_enabled OR t.affects_kit));

--> statement-breakpoint
-- Very old imports may not contain any assembly node.
INSERT INTO npi_tracking_items (program_id, manufacturing_plan_id, source_type, tracking_type, name, specification, qty, unit, owner_id, required_date, affects_kit, tracking_enabled)
SELECT p.program_id, m.id, 'WHOLE_MACHINE', 'assembly', '整机完成', p.motor_model, '1', '台', p.manufacturing_owner_id, p.prototype_required_date, false, true
FROM npi_projects p LEFT JOIN npi_manufacturing_plan m ON m.program_id=p.program_id
WHERE p.current_npi_stage <> 'completed'
AND NOT EXISTS (SELECT 1 FROM npi_tracking_items t WHERE t.program_id=p.program_id AND t.source_type='WHOLE_MACHINE');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS npi_whole_machine_project ON npi_tracking_items (program_id) WHERE source_type='WHOLE_MACHINE';
