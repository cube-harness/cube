import type { CatalogModel, GatewayId, ModelCatalog } from "@cube/workspace";
import { gatewayDescriptors } from "./types.js";

export type GatewayAvailability = {
  gatewayId: GatewayId;
  canonicalModelIds: string[];
};

const conservativeLocalModel = (
  providerId: "ollama" | "lmstudio",
  modelId: string,
): CatalogModel => ({
  modelId,
  name: modelId.slice(modelId.indexOf("/") + 1),
  family: providerId,
  reasoning: false,
  tool_call: false,
  structured_output: false,
  attachment: false,
  open_weights: true,
  limit: { context: 128_000, output: 8_192 },
  modalities: { input: ["text"], output: ["text"] },
});

export const buildGatewayCatalog = (
  canonical: ModelCatalog,
  availability: GatewayAvailability,
): ModelCatalog => {
  const descriptor = gatewayDescriptors[availability.gatewayId];
  const canonicalModels = new Map(
    Object.values(canonical.providers)
      .flatMap((provider) => provider.models)
      .map((model) => [model.modelId, model] as const),
  );
  const models = availability.canonicalModelIds.flatMap((modelId) => {
    const known = canonicalModels.get(modelId);
    if (known) return [known];
    if (descriptor.providerId === "ollama" || descriptor.providerId === "lmstudio") {
      return [conservativeLocalModel(descriptor.providerId, modelId)];
    }
    return [];
  });

  return {
    version: 2,
    updatedAt: canonical.updatedAt,
    providers: models.length === 0
      ? {}
      : {
          [descriptor.providerId]: {
            name: canonical.providers[descriptor.providerId]?.name ??
              (descriptor.providerId === "lmstudio" ? "LM Studio" : "Ollama"),
            models,
          },
        },
  };
};
