import {ObjectTypeDefinitionNode, DirectiveNode, InterfaceTypeDefinitionNode, FieldDefinitionNode, Kind} from 'graphql'
import {
  Transformer,
  TransformerContext,
  InvalidDirectiveError,
  gql,
  getDirectiveArguments,
} from 'graphql-transformer-core'
import {ResolverResourceIDs} from 'graphql-transformer-common'
import {printBlock, iff, not, raw, Expression, qref} from 'graphql-mapping-template'

export class TransformTransformer extends Transformer {
  constructor() {
    super(
      'TransformTransformer',
      gql`
        directive @transform(expression: String!) on FIELD_DEFINITION
      `
    )
  }

  public field = (
    parent: ObjectTypeDefinitionNode | InterfaceTypeDefinitionNode,
    definition: FieldDefinitionNode,
    directive: DirectiveNode,
    ctx: TransformerContext
  ) => {
    if (parent.kind === Kind.INTERFACE_TYPE_DEFINITION) {
      throw new InvalidDirectiveError(
        `The @transform directive cannot be placed on an interface's field. See ${parent.name.value}${definition.name.value}`
      )
    }

    // Validation - @model required
    this.validateParentModelDirective(parent!)

    const {expression} = getDirectiveArguments(directive)

    // Generate the VTL code block
    const typeName = parent.name.value
    const fieldName = definition.name.value

    const validationExpression = this.generateValidationExpression(fieldName, expression)

    const vtlCode = printBlock(`Transformation for "${fieldName}" (${expression})`)(validationExpression)

    // Update create and update mutations
    const createResolverResourceId = ResolverResourceIDs.DynamoDBCreateResolverResourceID(typeName)
    this.updateResolver(ctx, createResolverResourceId, vtlCode)

    const updateResolverResourceId = ResolverResourceIDs.DynamoDBUpdateResolverResourceID(typeName)
    this.updateResolver(ctx, updateResolverResourceId, vtlCode)
  }

  private validateParentModelDirective = (type: ObjectTypeDefinitionNode) => {
    const directive = type!.directives!.find((d) => d.name.value === 'model')

    if (!directive) {
      throw new Error(`@transform directive can only be used on types with @model directive.`)
    }
  }

  private quote = (s: string) => {
    return `'${s.replace(/'/g, "''")}'`
  }

  private generateValidationExpression = (fieldName: string, expression: string): Expression => {
    const name = this.quote(fieldName)
    const val = `$ctx.args.input.${fieldName}`
    const expr1 = expression.replace(/\B\.\B/g, val).replace(/(?=^|[^)\]}]\B)\./g, `${val}.`)
    return iff(not(raw(`$util.isNull(${val})`)), qref(`$ctx.args.input.put(${name}, ${expr1})`))
  }

  private updateResolver = (ctx: TransformerContext, resolverResourceId: string, code: string) => {
    const resolver = ctx.getResource(resolverResourceId)

    if (resolver) {
      const templateParts = [code, resolver!.Properties!.RequestMappingTemplate]
      resolver!.Properties!.RequestMappingTemplate = templateParts.join('\n\n')
      ctx.setResource(resolverResourceId, resolver)
    }
  }
}
