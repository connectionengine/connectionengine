import { z } from 'zod'

export const healthResponseSchema = z.object({
  status: z.string(),
  message: z.string()
})

export type HealthResponse = z.infer<typeof healthResponseSchema>
