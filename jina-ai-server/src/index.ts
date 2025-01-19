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

const API_KEY = process.env.JINA_API_KEY;
if (!API_KEY) {
  throw new Error('JINA_API_KEY environment variable is required');
}

interface JinaAIResponse {
  results: Array<{
    text?: string;
    image?: string;
    embedding?: number[];
  }>;
}

interface JinaAIRequest {
  type: 'read';
  input: string;
}

interface JinaAIResponse {
  data: string;
  status: number;
  headers: Record<string, string>;
}

const isValidJinaArgs = (
  args: any
): args is JinaAIRequest =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.type === 'string' &&
  args.type === 'read' &&
  typeof args.input === 'string';

class JinaAIServer {
  private server: Server;
  private axiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'jina-ai-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      baseURL: 'https://api.jina.ai',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
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
          name: 'process',
          description: 'Process text, generate images, or create embeddings using Jina AI',
          inputSchema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['read'],
                description: 'Read content from a URL',
              },
              input: {
                type: 'string',
                description: 'Input text or prompt',
              },
              parameters: {
                type: 'object',
                description: 'Additional parameters for the API call',
                additionalProperties: true,
              },
            },
            required: ['type', 'input'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'process') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      if (!isValidJinaArgs(request.params.arguments)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Invalid Jina AI arguments'
        );
      }

      const { type, input, parameters = {} } = request.params.arguments;

      try {
        const response = await this.axiosInstance.post<JinaAIResponse>(
          'https://r.jina.ai/',
          {
            url: input
          },
          {
            headers: {
              'Authorization': `Bearer ${API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );

        return {
          content: [
            {
              type: 'text',
              text: response.data,
            },
          ],
        };
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [
              {
                type: 'text',
                text: `Jina AI API error: ${
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
    console.error('Jina AI MCP server running on stdio');
  }
}

const server = new JinaAIServer();
server.run().catch(console.error);