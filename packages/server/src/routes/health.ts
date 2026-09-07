import { Router } from 'express'
import type { Request, Response } from 'express'
import { healthResponseSchema } from '../schemas/health'

const router = Router()

router.get('/', (_req: Request, res: Response) => {
  const result = healthResponseSchema.parse({
    status: 'ok',
    message: 'connectionengine'
  })
  res.json(result)
})

/**
 * The router that handles a health-check request.
 */
export default router
