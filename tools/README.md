# ULTRON Tools

Tools are registered capabilities available to the Executor.

Every tool should declare:

- `name`
- `description`
- `requiresConfirmation`
- `destructive`
- `externalSideEffect`
- input schema / validation

The Executor must be the only path that invokes registered actions.

Future adapters for Brahma, Jarvis/OpenJarvis, GitHub, browser automation, PowerShell, files, Gmail, Calendar, web search, and other integrations should follow this contract.
