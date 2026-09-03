import { SUPPORTED_PROXY_PROTOCOLS } from '@utils/makeProxyAgent';
import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

/**
 * Protocolos aceitos: DERIVADOS do `makeProxyAgent`, nunca redigitados aqui.
 *
 * Fora dessa lista ele LANCA, e o erro chegava na sonda como se fosse a porta que nao
 * respondeu (issue cnpjbiz#2457). Manter a lista em dois lugares seria pior que nao validar:
 * um enum mais estreito que o suportado converte sonda boa em erro de config na frota
 * INTEIRA, que e o mesmo tipo de falha auto-infligida em massa que esta issue combate.
 */
const PROTOCOLOS = [...SUPPORTED_PROXY_PROTOCOLS];

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
    protocol: {
      type: 'string',
      enum: PROTOCOLOS,
      description: `The "protocol" must be one of: ${PROTOCOLOS.join(', ')}`,
    },
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
    port: { type: 'string', pattern: '^[0-9]{1,5}$', description: 'The "port" must be numeric' },
    protocol: {
      type: 'string',
      enum: PROTOCOLOS,
      description: `The "protocol" must be one of: ${PROTOCOLOS.join(', ')}`,
    },
    username: { type: 'string' },
    password: { type: 'string' },
  },
  required: ['host', 'port', 'protocol'],
  ...isNotEmpty('host', 'port', 'protocol'),
};
