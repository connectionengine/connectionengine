import { z } from 'zod'

/**
 * The schema of the health-check API response.
 */
export const healthResponseSchema = z.object({
  status: z.string(),
  message: z.string()
})

/**
 * The type that TypeScript infers from healthResponseSchema.
 */
export type HealthResponse = z.infer<typeof healthResponseSchema>
