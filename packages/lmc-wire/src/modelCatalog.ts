import { z } from 'zod';

export const DiscoveredModelSchema = z.object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    description: z.string().max(4096).optional(),
    aliases: z.array(z.string().max(256)).max(32).optional(),
    // Missing means unknown; [] means the provider explicitly supports no effort.
    efforts: z.array(z.string().min(1).max(64)).max(32).optional(),
    effortModels: z.record(z.string().max(64), z.string().min(1).max(256)).optional(),
    defaultEffort: z.string().max(64).optional(),
    supportsFastMode: z.boolean().optional(),
    isDefault: z.boolean().optional(),
});
export const EngineModelCatalogSchema = z.object({
    source: z.enum(['native', 'poe']).optional(),
    models: z.array(DiscoveredModelSchema).max(256),
    capturedAt: z.number(),
    runtimeVersion: z.string(),
    stale: z.boolean().optional(),
});
export const ModelCatalogsSchema = z.object({
    claude: EngineModelCatalogSchema.optional(),
    codex: EngineModelCatalogSchema.optional(),
    agy: EngineModelCatalogSchema.optional(),
});
export type DiscoveredModel = z.infer<typeof DiscoveredModelSchema>;
export type EngineModelCatalog = z.infer<typeof EngineModelCatalogSchema>;
export type ModelCatalogs = z.infer<typeof ModelCatalogsSchema>;

export function findCatalogModel(catalog: EngineModelCatalog | undefined, id: string | null | undefined) {
    return catalog?.models.find(model => model.id === id || model.aliases?.includes(id ?? ''));
}
