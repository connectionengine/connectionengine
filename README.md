# Template Monorepo

This is a modern, full-stack TypeScript monorepo template managed with **pnpm workspaces**. It provides a pre-configured environment for building scalable applications with a shared core library, a SolidJS client, and an Express server.

## 📂 Project Structure

The monorepo is organized into the following packages:

- **`packages/client`**: A frontend application built with **SolidJS**, **Vite**, and **Tailwind CSS**. It includes **Storybook** for component development and **Playwright** for end-to-end testing.
- **`packages/server`**: A backend server built with **Express**. It uses **tsx** for fast development execution.
- **`packages/core`**: A shared library containing common logic, types, or utilities used by both the client and server. It is bundled using **Rollup**.

## 🚀 Getting Started

### Prerequisites

- **Node.js** (Latest LTS recommended)
- **pnpm** (Package manager)

### Installation

Install all dependencies across the monorepo:

```bash
pnpm install
```

### Development

Start the development servers for both the client and server concurrently:

```bash
pnpm dev
```

- **Client**: http://localhost:5173 (default Vite port)
- **Server**: Check console output for port (typically configured in `src/index.ts`)

## 🛠 Scripts

Run these scripts from the root directory:

| Script         | Description                                                |
| :------------- | :--------------------------------------------------------- |
| `pnpm dev`     | Starts client and server in development mode concurrently. |
| `pnpm build`   | Builds all packages in the workspace.                      |
| `pnpm test`    | Runs tests across all packages (Vitest & Playwright).      |
| `pnpm lint`    | Lints code using ESLint.                                   |
| `pnpm format`  | Formats code using Prettier.                               |
| `pnpm check`   | Runs type checking (`tsc`) and linting.                    |
| `pnpm prepare` | Sets up Husky git hooks.                                   |

## 🧰 Tech Stack & Tooling

### Core Technologies

- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Package Manager**: [pnpm](https://pnpm.io/) (Workspaces)
- **Build Tools**: [Vite](https://vitejs.dev/) (Client), [Rollup](https://rollupjs.org/) (Core)

### Frontend (`packages/client`)

- **Framework**: [SolidJS](https://www.solidjs.com/)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Testing**: [Playwright](https://playwright.dev/)
- **Documentation**: [Storybook](https://storybook.js.org/)

### Backend (`packages/server`)

- **Framework**: [Express](https://expressjs.com/)
- **Runtime**: [tsx](https://github.com/privatenumber/tsx) (TypeScript execution)

### Shared (`packages/core`)

- **Testing**: [Vitest](https://vitest.dev/)

### DevOps & Code Quality

- **Linting**: [ESLint](https://eslint.org/) (v9, Flat Config)
- **Formatting**: [Prettier](https://prettier.io/)
- **Git Hooks**: [Husky](https://typicode.github.io/husky/) & [lint-staged](https://github.com/okonet/lint-staged)
- **CI/CD Readiness**: Scripts are optimized for CI environments (`check`, `test`, `build`).

## ⚙️ Configuration Files

- `pnpm-workspace.yaml`: Defines the workspace structure.
- `eslint.config.ts`: Root ESLint configuration (Flat Config).
- `prettier.config.js`: Prettier configuration.
- `tsconfig.json`: Base TypeScript configuration.
