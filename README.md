# Slack Member Comparer

A TypeScript CLI tool for comparing members between Slack channels using Bun runtime. This tool shows the symmetric difference - members who are in one channel but not the other.

## Features

- 🔍 Compare members between any two Slack channels
- 📊 Formatted table output with names, emails, and usernames
- 🎯 Shows symmetric difference (members unique to each channel)
- 🔗 Works with channel names (no need for channel IDs)
- ⚡ Fast execution with Bun runtime
- 🔐 Secure token management via environment variables
- 🎨 Colorized terminal output

## Prerequisites

- [Bun](https://bun.sh/) runtime installed
- Slack app with Bot User OAuth Token
- Required Slack permissions:
  - `channels:read` - to list channel members
  - `users:read` - to get user profiles
  - `users:read.email` - to access email addresses

## Installation

1. **Clone or download this project:**
   ```bash
   git clone <repository-url>
   cd slack-member-comparer
   ```

2. **Install dependencies:**
   ```bash
   bun install
   ```

3. **Set up environment variables:**
   Create a `.env` file in the project root:
   ```bash
   # Slack Bot User OAuth Token (starts with xoxb-)
   SLACK_TOKEN=xoxb-your-slack-token-here
   ```

   > **Important:** Never commit your `.env` file to version control. It's already included in `.gitignore`.

## Usage

### Basic Comparison

Compare two channels by name:

```bash
bun run start general random
```

Or with the `#` prefix:

```bash
bun run start "#general" "#random"
```

### Using the Compare Command Explicitly

```bash
bun run start compare general random
```

### Verbose Mode

Get additional details about the comparison:

```bash
bun run start compare general random --verbose
```

### Help

```bash
bun run start --help
bun run start compare --help
```

## Example Output

```
🔀 Comparing members between #general and #marketing...

📊 Comparison Results

📈 Summary:
   • Members only in #general: 3
   • Members only in #marketing: 2
   • Total unique members: 5

👥 Members only in #general:
┌─────────────────────┬──────────────────────────┬──────────────┐
│ Name                │ Email                    │ Username     │
├─────────────────────┼──────────────────────────┼──────────────┤
│ John Smith          │ john.smith@company.com   │ @johnsmith   │
│ Jane Doe            │ jane.doe@company.com     │ @janedoe     │
│ Bob Wilson          │ bob.wilson@company.com   │ @bobwilson   │
└─────────────────────┴──────────────────────────┴──────────────┘

👥 Members only in #marketing:
┌─────────────────────┬──────────────────────────┬──────────────┐
│ Name                │ Email                    │ Username     │
├─────────────────────┼──────────────────────────┼──────────────┤
│ Alice Johnson       │ alice.j@company.com      │ @alice       │
│ Mike Brown          │ mike.brown@company.com   │ @mikebrown   │
└─────────────────────┴──────────────────────────┴──────────────┘
```

## Architecture

This is a **local project** architecture, meaning:
- ✅ Run from within the project directory
- ✅ Easy to customize and modify
- ✅ Simple setup and maintenance
- ✅ No need for global installation

### Project Structure

```
slack-member-comparer/
├── src/
│   ├── commands/
│   │   └── compare.ts          # Compare command implementation
│   ├── lib/
│   │   └── slack.ts           # Slack API client wrapper
│   ├── types/
│   │   └── index.ts           # TypeScript type definitions
│   └── index.ts               # Main CLI entry point
├── .env                       # Environment variables (create this)
├── .gitignore                 # Git ignore rules
├── package.json               # Project dependencies
├── tsconfig.json              # TypeScript configuration
└── README.md                  # This file
```

## How it Works

1. **Channel Resolution**: The tool accepts channel names and automatically resolves them to channel IDs using the Slack API
2. **Member Fetching**: Retrieves all members from both channels with pagination support
3. **User Information**: Fetches detailed user profiles including names and emails
4. **Symmetric Difference**: Compares the member lists and identifies users unique to each channel
5. **Formatted Output**: Displays results in formatted tables with color coding

## Troubleshooting

### "Channel not found" Error
- Ensure your bot is added to private channels
- Check that channel names are spelled correctly
- Try with and without the `#` prefix

### "Failed to connect to Slack" Error
- Verify your `SLACK_TOKEN` in the `.env` file
- Ensure the token starts with `xoxb-`
- Check that your Slack app has the required permissions

### Rate Limiting
- The tool includes automatic rate limiting with delays between API calls
- Large channels may take longer to process

### Permission Errors
Ensure your Slack app has these OAuth scopes:
- `channels:read` - List public channels
- `groups:read` - List private channels (if needed)
- `users:read` - Read user profiles
- `users:read.email` - Read user email addresses

## Development

### Type Checking
```bash
bun run type-check
```

### Build
```bash
bun run build
```

### Available Scripts
- `bun run start` - Run the CLI tool
- `bun run dev` - Same as start (for development)
- `bun run build` - Build the project
- `bun run type-check` - Check TypeScript types

## Contributing

This is a functional-first codebase focusing on:
- Pure functions where possible
- Clear separation of concerns
- Testable and readable code
- Strong typing with TypeScript

## License

MIT License - see the LICENSE file for details.
