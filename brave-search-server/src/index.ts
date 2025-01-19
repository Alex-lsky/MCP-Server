#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

const API_KEY = process.env.BRAVE_API_KEY;
if (!API_KEY) {
  throw new Error('BRAVE_API_KEY environment variable is required');
}

interface BraveSearchResponse {
  web: {
    results: Array<{
      title: string;
      url: string;
      description: string;
    }>;
  };
}

const isValidSearchArgs = (
  args: any
): args is { query: string; count?: number } =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.query === 'string' &&
  (args.count === undefined || typeof args.count === 'number');

class BraveSearchServer {
  private server: Server;
  private axiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'brave-search-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: 'https://api.search.brave.com/res/v1',
      headers: {
        'X-Subscription-Token': API_KEY,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
    });

    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search',
          description: 'Search the web using Brave Search API',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
              count: {
                type: 'number',
                description: 'Number of results (1-10)',
                minimum: 1,
                maximum: 10,
              },
            },
            required: ['query'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'search') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      if (!isValidSearchArgs(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid search arguments'
        );
      }

      const { query, count = 5 } = request.params.arguments;

      try {
        const response = await this.axiosInstance.get<BraveSearchResponse>(
          '/web/search',
          {
            params: {
              q: query,
              count: count,
            },
          }
        );

        const results = response.data.web.results.map((result: { title: string; url: string; description: string }) => ({
          title: result.title,
          url: result.url,
          description: result.description,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [
              {
                type: 'text',
                text: `Brave Search API error: ${
                  error.response?.data?.message ?? error.message
                }`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Brave Search MCP server running on stdio');
  }
}

const server = new BraveSearchServer();
server.run().catch(console.error);