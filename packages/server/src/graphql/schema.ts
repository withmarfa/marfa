export const typeDefs = /* GraphQL */ `
  scalar JSON

  type Query {
    item(id: ID!): Item
    items(
      type: String
      state: String
      source: String
      filter: String
      limit: Int
      cursor: String
    ): ItemConnection!
    search(
      query: String!
      type: String
      state: String
      limit: Int
    ): [SearchResult!]!
    threads(limit: Int, cursor: String): ThreadConnection!
    thread(id: ID!): Thread
    types: [TypeSchema!]!
    type(id: ID!): TypeSchema
  }

  type Mutation {
    createItem(input: CreateItemInput!): ItemPayload!
    updateItem(id: ID!, properties: JSON!, version: Int): ItemPayload!
    deleteItem(id: ID!): DeletePayload!
    restoreItem(id: ID!): ItemPayload!
    transitionItem(id: ID!, state: String!): ItemPayload!
    addTags(itemId: ID!, tags: [String!]!): MetadataPayload!
    removeTag(itemId: ID!, tag: String!): MetadataPayload!
    setMetadata(itemId: ID!, tags: [String!], about: [String!]): MetadataPayload!
  }

  type Subscription {
    itemChanged(type: String): ItemEvent!
  }

  input CreateItemInput {
    type: String!
    properties: JSON!
    id: ID
    state: String
    timestamp: String
    source: String
    source_id: String
    origin: String
    device_id: String
    parent_id: String
    thread_id: String
    tags: [String!]
    about: [String!]
  }

  type Item {
    id: ID!
    type: String!
    state: String!
    properties: JSON!
    created_at: String!
    updated_at: String!
    timestamp: String!
    source: String
    source_id: String
    origin: String
    version: Int!
    schema_version: Int
    device_id: String
    parent_id: String
    thread_id: String
    capture_latitude: Float
    capture_longitude: Float
    metadata: Metadata!
  }

  type Metadata {
    item_id: ID!
    tags: [String!]!
    about: [String!]!
  }

  type ItemPayload {
    item: Item!
    metadata: Metadata!
  }

  type DeletePayload {
    ok: Boolean!
  }

  type MetadataPayload {
    metadata: Metadata!
  }

  type ItemConnection {
    data: [Item!]!
    cursor: String
    has_more: Boolean!
  }

  type SearchResult {
    item: Item!
    metadata: Metadata!
    relevance_score: Float!
    snippet: String
  }

  type ThreadConnection {
    data: [Thread!]!
    cursor: String
    has_more: Boolean!
  }

  type Thread {
    id: ID!
    created_at: String!
    updated_at: String!
    items: [Item!]!
  }

  type TypeSchema {
    id: String!
    version: Int!
    parent: String
    fields: JSON!
    states: [String!]!
    default_state: String!
    transitions: JSON!
  }

  type ItemEvent {
    type: String!
    item: Item!
    metadata: Metadata
  }
`;
