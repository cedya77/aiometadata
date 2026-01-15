# Development Guide

This guide will help you set up your development environment and understand the project structure.

## Prerequisites

- Node.js 20.x or higher
- npm 9.x or higher
- Git
- MongoDB (local or Atlas)
- Basic knowledge of TypeScript and React

## Project Structure

```
tmdb-addon/
├── addon/           # Backend server code
├── configure/       # Frontend configuration UI
├── docs/           # Documentation
├── node_modules/   # Dependencies
└── package.json    # Project configuration
```

## Setting Up Development Environment

1. Clone the repository:
```bash
git clone https://github.com/mrcanelas/tmdb-addon.git
cd tmdb-addon
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` with your development credentials:
```env
MONGODB_URI=your_mongodb_uri
FANART_API=your_fanart_key
TMDB_API=your_tmdb_key
RPDB_API_KEY=your_rpdb_key
HOST_NAME=http://localhost:3232
PORT=3232
```

4. Start development server:
```bash
# Terminal 1 - Backend
npm run dev:server

# Terminal 2 - Frontend
npm run dev
```

## Development Workflow

1. **Create a new branch**:
```bash
git checkout -b feature/your-feature-name
```

2. **Make your changes**:
- Backend changes go in the `addon/` directory
- Frontend changes go in the `configure/` directory

3. **Testing**:
```bash
# Run tests
npm test

# Run linter
npm run lint
```

4. **Building**:
```bash
npm run build
```

## Code Style

We use ESLint and Prettier for code formatting. Configuration can be found in:
- `.eslintrc.js`
- `.prettierrc`

## Hot Reload

- Backend uses `nodemon` for automatic reloading
- Frontend uses Vite's hot module replacement

## Debugging

### Backend Debugging

1. Using VS Code:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Server",
      "program": "${workspaceFolder}/addon/server.js",
      "outFiles": ["${workspaceFolder}/dist/**/*.js"]
    }
  ]
}
```

2. Using Chrome DevTools:
```bash
node --inspect addon/server.js
```

### Frontend Debugging

1. Use React Developer Tools browser extension
2. Vite's development server includes source maps

## Common Development Tasks

### Adding New UI Components

1. Create component in `configure/components/`
2. Add styles using Tailwind CSS
3. Import and use in relevant pages

## Best Practices

1. **Code Organization**:
   - Keep components small and focused
   - Use TypeScript interfaces for type safety
   - Follow the Single Responsibility Principle

2. **Performance**:
   - Implement caching where appropriate
   - Use pagination for large datasets
   - Optimize API calls

3. **Security**:
   - Validate all user inputs
   - Use environment variables for secrets
   - Implement rate limiting

4. **Testing**:
   - Write unit tests for critical functions
   - Test edge cases
   - Use meaningful test descriptions 