import {ObjectTypeDefinitionNode, DirectiveNode, InterfaceTypeDefinitionNode, FieldDefinitionNode, Kind} from 'graphql'
import {
  Transformer,
  TransformerContext,
  InvalidDirectiveError,
  gql,
  getDirectiveArguments,
} from 'graphql-transformer-core'
import {ResolverResourceIDs, isNonNullType, isListType, unwrapNonNull} from 'graphql-transformer-common'
import {printBlock, iff, forEach, not, raw, Expression, qref, ref} from 'graphql-mapping-template'

export class TransformTransformer extends Transformer {
  constructor() {
    super(
      'TransformTransformer',
      gql`
        directive @transform(expression: String!, foreach: Boolean = false, always: Boolean = false) on FIELD_DEFINITION
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

    const {expression, foreach, always} = getDirectiveArguments(directive)

    if (foreach) {
      // Validation - List required
      this.validateListFieldType(definition)
    }

    // Generate the VTL code block
    const typeName = parent.name.value
    const fieldName = definition.name.value

    const transformExpression = this.generateTransformExpression(fieldName, expression, foreach, always)

    const vtlCode = printBlock(
      `Transformation for "${fieldName}" (${expression}, foreach=${foreach}, always=${always})`
    )(transformExpression)

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

  private validateListFieldType = (field: FieldDefinitionNode) => {
    let isValidType = isListType(field.type)

    if (isNonNullType(field.type)) {
      isValidType = isListType(unwrapNonNull(field.type).type)
    }

    if (!isValidType) {
      throw new InvalidDirectiveError(
        `@transform directive with foreach=true option can only be used on list type fields.`
      )
    }
  }

  private quote = (s: string) => {
    return `'${s.replace(/'/g, "''")}'`
  }

  private generateTransformExpression = (
    fieldName: string,
    expression: string,
    foreach: boolean,
    always: boolean
  ): Expression => {
    const name = this.quote(fieldName)
    const val = `$ctx.args.input.${fieldName}`
    const emit: (expr: Expression) => Expression = always
      ? (expr: Expression) => expr
      : (expr: Expression) => iff(not(raw(`$util.isNull(${val})`)), expr)

    if (foreach) {
      const expr1 = expression.replace(/\B\.\B/g, `$entry`).replace(/(?=^|[^)\]}]\B)\./g, `$entry.`)
      return emit(forEach(ref('entry'), ref(val.slice(1)), [qref(`${val}.set($foreach.index, ${expr1})`)]))
    } else {
      const expr1 = expression.replace(/\B\.\B/g, val).replace(/(?=^|[^)\]}]\B)\./g, `${val}.`)
      return emit(qref(`$ctx.args.input.put(${name}, ${expr1})`))
    }
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
