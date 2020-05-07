import {GraphQLTransform} from 'graphql-transformer-core'
import {TransformTransformer} from '../TransformTransformer'
import {DynamoDBModelTransformer} from 'graphql-dynamodb-transformer'

test('@transform fails without @model.', () => {
  const validSchema = `
    type Post {
        id: ID!
        title: String! @transform(expression: ".trim()")
        version: String!
    }
    `
  try {
    const transformer = new GraphQLTransform({
      transformers: [new DynamoDBModelTransformer(), new TransformTransformer()],
    })
    transformer.transform(validSchema)
  } catch (e) {
    expect(e.name).toEqual('InvalidDirectiveError')
  }
})
