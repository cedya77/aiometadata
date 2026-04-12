# Contributing Guide

Thank you for your interest in contributing to the TMDB Addon! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct. Please read it before contributing.

## How Can I Contribute?

### Reporting Bugs

1. Check if the bug has already been reported in the Issues section
2. If not, create a new issue using the bug report template
3. Include:
   - Clear title and description
   - Steps to reproduce
   - Expected behavior
   - Actual behavior
   - Screenshots if applicable
   - Your environment details

### Suggesting Enhancements

1. Check if the enhancement has been suggested in the Issues section
2. If not, create a new issue using the feature request template
3. Include:
   - Clear title and description
   - Use case
   - Proposed solution
   - Alternative solutions considered

### Pull Requests

1. Fork the repository
2. Create a new branch:
   ```bash
   git checkout -b feature/your-feature
   ```
3. Make your changes
4. Run tests and linting:
   ```bash
   npm test
   npm run lint
   ```
   Use `npm run lint:backend`, `npm run lint:frontend`, or `npm run lint:repo` when you only need one scope during local iteration.
5. Commit your changes:
   ```bash
   git commit -m "feat: add some feature"
   ```
   We use [Conventional Commits](https://www.conventionalcommits.org/) specification.

6. Push to your fork:
   ```bash
   git push origin feature/your-feature
   ```
7. Open a Pull Request

## Commit Message Guidelines

We follow the Conventional Commits specification:

- `feat:` - A new feature
- `fix:` - A bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc)
- `refactor:` - Code changes that neither fix bugs nor add features
- `perf:` - Performance improvements
- `test:` - Adding or modifying tests
- `chore:` - Changes to build process or auxiliary tools

Example:
```
feat: add support for custom catalogs

- Add catalog interface
- Implement catalog registration
- Add documentation
```

## Development Process

1. **Pick an Issue**:
   - Look for issues labeled `good first issue` or `help wanted`
   - Comment on the issue to let others know you're working on it

2. **Development**:
   - Follow the [Development Guide](development.md)
   - Keep changes focused and atomic
   - Add tests for new features

3. **Code Review**:
   - All submissions require review
   - Be open to feedback and suggestions
   - Respond to comments promptly

## Style Guide

- Follow the existing code style
- Use TypeScript for type safety
- Write meaningful comments
- Keep functions small and focused
- Use descriptive variable names

## Testing

- Write tests for new features
- Ensure all tests pass before submitting
- Include both unit and integration tests
- Test edge cases

## Documentation

- Update documentation for new features
- Include JSDoc comments for functions
- Update README if necessary
- Add examples when helpful

## Need Help?

- Check the [Development Guide](development.md)
- Look through closed issues for similar problems
- Ask questions in the discussions section
- Join our community chat

## Recognition

Contributors will be recognized in:
- The project's README
- Release notes
- Our contributors page

Thank you for contributing to AIOMetadata! 
