INSERT INTO model_assumption (code, applies_to, description, unit, low_value, base_value, high_value, rationale, source_id) VALUES
('p_visible_vehicle','vehicle','Share of people in passing traffic for whom a van/truck side panel is in view','share',0.1,0.2,0.3,
 'JPG planning assumption: only part of opposing/adjacent traffic has a clear line of sight to a side panel. Not measured.','jpg_assumptions')
ON CONFLICT DO NOTHING;
