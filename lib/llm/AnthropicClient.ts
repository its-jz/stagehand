import Anthropic from "@anthropic-ai/sdk";
import { LLMClient, ChatCompletionOptions } from "./LLMClient";
import { zodToJsonSchema } from "zod-to-json-schema";
import { LLMCache } from "../cache/LLMCache";

export class AnthropicClient implements LLMClient {
  private client: Anthropic;
  private cache: LLMCache;
  public logger: (message: {
    category?: string;
    message: string;
    level?: number;
  }) => void;
  private enableCaching: boolean;
  private requestId: string;

  constructor(
    logger: (message: {
      category?: string;
      message: string;
      level?: number;
    }) => void,
    enableCaching = false,
    cache: LLMCache,
    requestId: string,
  ) {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    this.logger = logger;
    this.cache = cache;
    this.enableCaching = enableCaching;
    this.requestId = requestId;
  }

  async createChatCompletion(
    options: ChatCompletionOptions & { retries?: number },
  ) {
    const { image: _, ...optionsWithoutImage } = options;
    this.logger({
      category: "Anthropic",
      message: `Creating chat completion with options: ${JSON.stringify(
        optionsWithoutImage,
        null,
        2,
      )}`,
      level: 1,
    });
    // Try to get cached response
    const cacheOptions = {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      image: options.image,
      response_model: options.response_model,
      tools: options.tools,
      retries: options.retries,
    };

    if (this.enableCaching) {
      const cachedResponse = await this.cache.get(cacheOptions, this.requestId);
      if (cachedResponse) {
        this.logger({
          category: "llm_cache",
          message: `LLM Cache hit - returning cached response`,
          level: 1,
        });
        return cachedResponse;
      } else {
        this.logger({
          category: "llm_cache",
          message: `LLM Cache miss - no cached response found`,
          level: 1,
        });
      }
    }

    const systemMessage = options.messages.find((msg) => msg.role === "system");
    const userMessages = options.messages.filter(
      (msg) => msg.role !== "system",
    );

    if (options.image) {
      const screenshotMessage: any = {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: options.image.buffer.toString("base64"),
            },
          },
          ...(options.image.description
            ? [{ type: "text", text: options.image.description }]
            : []),
        ],
      };

      options.messages = [...options.messages, screenshotMessage];
    }

    // Transform tools to Anthropic's format
    let anthropicTools = options.tools?.map((tool: any) => {
      if (tool.type === "function") {
        return {
          name: tool.function.name,
          description: tool.function.description,
          input_schema: {
            type: "object",
            properties: tool.function.parameters.properties,
            required: tool.function.parameters.required,
          },
        };
      }
      return tool;
    });

    let toolDefinition;
    if (options.response_model) {
      const jsonSchema = zodToJsonSchema(options.response_model.schema);

      // Extract the actual schema properties
      const schemaProperties =
        jsonSchema.definitions?.MySchema?.properties || jsonSchema.properties;
      const schemaRequired =
        jsonSchema.definitions?.MySchema?.required || jsonSchema.required;

      toolDefinition = {
        name: "print_extracted_data",
        description: "Prints the extracted data based on the provided schema.",
        input_schema: {
          type: "object",
          properties: schemaProperties,
          required: schemaRequired,
        },
      };
    }

    if (toolDefinition) {
      anthropicTools = anthropicTools ?? [];
      anthropicTools.push(toolDefinition);
    }

    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.max_tokens || 1500,
      messages: userMessages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      tools: anthropicTools,
      system: systemMessage?.content,
      temperature: options.temperature,
    });

    this.logger({
      category: "Anthropic",
      message: `Response: ${JSON.stringify(response, null, 2)}`,
      level: 1,
    });

    // Parse the response here
    const transformedResponse = {
      id: response.id,
      object: "chat.completion",
      created: Date.now(),
      model: response.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              response.content.find((c) => c.type === "text")?.text || null,
            tool_calls: response.content
              .filter((c) => c.type === "tool_use")
              .map((toolUse: any) => ({
                id: toolUse.id,
                type: "function",
                function: {
                  name: toolUse.name,
                  arguments: JSON.stringify(toolUse.input),
                },
              })),
          },
          finish_reason: response.stop_reason,
        },
      ],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens:
          response.usage.input_tokens + response.usage.output_tokens,
      },
    };

    this.logger({
      category: "Anthropic",
      message: "Transformed response: " + JSON.stringify(transformedResponse),
    });

    if (options.response_model) {
      const toolUse = response.content.find((c) => c.type === "tool_use");
      if (toolUse && "input" in toolUse) {
        const result = toolUse.input;
        if (this.enableCaching) {
          this.cache.set(cacheOptions, result, this.requestId);
        }

        return result;
      } else {
        if (!options.retries || options.retries < 5) {
          return this.createChatCompletion({
            ...options,
            retries: (options.retries ?? 0) + 1,
          });
        }
        throw new Error(
          "Create Chat Completion Failed: No tool use with input in response",
        );
      }
    }

    if (this.enableCaching) {
      this.cache.set(cacheOptions, transformedResponse, this.requestId);
    }

    return transformedResponse;
  }
}
