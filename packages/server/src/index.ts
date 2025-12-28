import express from 'express';
import cors from 'cors';
import { SHARED_CONSTANT } from '@connectionengine/core';

const app = express();
const port = 3001;

app.use(cors());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', message: SHARED_CONSTANT });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
