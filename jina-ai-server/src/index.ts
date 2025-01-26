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
import fs from 'fs';
import path from 'path';

const API_KEY = process.env.JINA_API_KEY;
if (!API_KEY) {
  throw new Error('JINA_API_KEY environment variable is required');
}

interface JinaAIRequest {
  type: 'read';
  input: string;
  parameters?: Record<string, any>;
}

interface JinaAIResponse {
  content: string;
  data?: {
    content: string;
    metadata?: Record<string, any>;
  };
  status: number;
  headers: Record<string, string>;
}

interface JinaAPIError {
  message: string;
  code?: number;
  details?: any;
}

const isValidJinaArgs = (
  args: any
): args is JinaAIRequest =>
  typeof args === 'object' &&
  args !== null &&
  typeof args.type === 'string' &&
  args.type === 'read' &&
  typeof args.input === 'string' && (args.input.startsWith('http://') || args.input.startsWith('https://') || !args.input.startsWith('http'));

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

      const { type, input, parameters = {} }: JinaAIRequest = request.params.arguments;
      
      try {
        let textContent = '';
        let isPDF = false;

        if (input.startsWith('http://') || input.startsWith('https://')) {
          // 处理 URL 输入
          console.error(`正在获取 URL 内容: ${input}`);
          const urlResponse = await axios.get(input, { responseType: 'arraybuffer' });
          const contentType = urlResponse.headers['content-type'];

          if (contentType === 'application/pdf') {
            // 处理 PDF URL
            isPDF = true;
            const pdfBuffer = Buffer.from(urlResponse.data);
            const pdfText = await require('pdf-parse')(pdfBuffer);
            textContent = pdfText.text;
          } else {
            // 处理 HTML 或其他文本 URL
            textContent = urlResponse.data.toString('utf-8');
          }
        } else {
          // 处理本地文件路径
          const pdfPath = path.resolve(input);
          if (!fs.existsSync(pdfPath)) {
            return {
              content: [{
                type: 'text',
                text: `文件未找到：${pdfPath}`
              }],
              isError: true
            };
          }
          isPDF = true;
          const pdfData = fs.readFileSync(pdfPath, { encoding: 'base64' });
        }
        
        // 调用 Jina Reader API
        console.error('正在发送 Jina API 请求...');
        console.error(`请求配置 (部分展示): ${JSON.stringify({
          url: 'https://r.jina.ai/',
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
          },
          data: isPDF ? { 
            url: "https://local-pdf-analysis",
            pdf: '...' // PDF 内容省略
          } : {
            url: "https://r.jina.ai/", // Corrected URL for web page analysis - using "https://r.jina.ai/" here
            text: textContent.substring(0, 100) + '...' // 文本内容省略
          }
        }, null, 2)}`);

        const response = await this.axiosInstance.post(
          'https://r.jina.ai/', // Using the general API endpoint "https://r.jina.ai/"
          isPDF ? { // 根据内容类型选择请求体
            url: "https://local-pdf-analysis",
            pdf: isPDF ? fs.readFileSync(path.resolve(input), { encoding: 'base64' }) : undefined // PDF 内容
          } : {
            url: input, // Corrected to use input URL for web page analysis
            text: textContent // 文本内容
          },
          {
            headers: {
              'Authorization': `Bearer ${API_KEY}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            timeout: 120000
          }
        );

        // 处理标准API响应
        console.error('完整API响应:', JSON.stringify({
          status: response.status,
          headers: response.headers,
          data: response.data
        }, null, 2));

        // 提取实际内容
        const content = response.data?.data?.content || response.data?.content;
        
        if (content) {
          return {
            content: [{
              type: 'text',
              text: content
            }]
          };
        } else {
          // 标准化错误格式
          const errorResponse: JinaAPIError = {
            message: '无效的API响应格式',
            details: {
              receivedType: typeof response.data,
              statusCode: response.status
            }
          };
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(errorResponse, null, 2)
            }],
            isError: true
          };
        }
      } catch (error: any) { // Explicitly type error as any
        if (axios.isAxiosError(error)) {
          return {
            content: [
              {
                type: 'text',
                text: `Jina AI API error: ${error.response?.data?.message ?? error.message}`,
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