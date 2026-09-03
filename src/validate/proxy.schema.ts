import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

const isNotEmpty = (...propertyNames: string[]): JSONSchema7 => {
  const properties = {};
  propertyNames.forEach(
    (property) =>
      (properties[property] = {
        minLength: 1,
        description: `The "${property}" cannot be empty`,
      }),
  );
  return {
    if: {
      propertyNames: {
        enum: [...propertyNames],
      },
    },
    then: { properties },
  };
};

export const proxySchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    enabled: { type: 'boolean', enum: [true, false] },
    host: { type: 'string' },
    port: { type: 'string' },
    protocol: { type: 'string' },
    username: { type: 'string' },
    password: { type: 'string' },
  },
  required: ['enabled', 'host', 'port', 'protocol'],
  ...isNotEmpty('enabled', 'host', 'port', 'protocol'),
};

/**
 * Sonda de porta (`POST /proxy/test`, issue cnpjbiz#2457): mesma forma do `proxySchema`
 * SEM o `enabled`, que ali significa "ligar o proxy nesta instancia" e aqui nao existe —
 * a sonda nao tem instancia. Exigi-lo obrigaria o CRM a mandar um campo sem sentido para
 * a operacao, e aceitar `enabled:false` faria a rota medir uma porta vazia.
 */
export const proxyTestSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    host: { type: 'string' },
    port: { type: 'string' },
    protocol: { type: 'string' },
    username: { type: 'string' },
    password: { type: 'string' },
  },
  required: ['host', 'port', 'protocol'],
  ...isNotEmpty('host', 'port', 'protocol'),
};
