import { z } from 'zod';
import { NumberFormatter,CurrencyCode,CurrencyPrecision,ProgressNumberFormatter,RatingSymbol,DateFormatter } from './enums.js';


// // Base field schema
const BaseFieldSchema = z.object({
  field_name: z.string(),
  type: z.number(),
  ui_type: z.enum([
    'Text',
    'Barcode',
    'Number',
    'Email',
    'Progress',
    'Currency',
    'Rating',
    'SingleSelect',
    'MultiSelect',
    'DateTime',
    'Checkbox',
    'User',
    'GroupChat',
    'Phone',
    'Url',
    'Attachment',
    'SingleLink',
    'Formula',
    'DuplexLink',
    'Location',
    'CreatedTime',
    'ModifiedTime',
    'CreatedUser',
    'ModifiedUser',
    'AutoNumber'
  ]).optional(),
  description: z.object({
    disable_sync: z.boolean().optional(),
    text: z.string().optional(),
  }).optional(),
  field_id: z.string().optional(),
  property: z.any().optional(),
}).describe('创建字段/表单时字段的schema');

// Merge schemas with type 1
export const Type1FieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(1),
  ui_type: z.enum(['Text', 'Email', 'Barcode']),
}).describe('schema of fields with type 1: Text, Email, Barcode');

export const CurrencyFieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(2),
  ui_type: z.literal('Currency'),
  property: z.object({
    currency_code: z.nativeEnum(CurrencyCode).optional(),
    formatter: z.nativeEnum(CurrencyPrecision).optional(),
  }),
}).describe('schema of a Currency field');


export const ProgressFieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(2),
  ui_type: z.literal('Progress'),
  property: z.object({
    formatter: z.nativeEnum(ProgressNumberFormatter).optional(),
    range_customize: z.boolean().optional(),
    max: z.number().optional().describe('range_customize=true时，必填'),
    min: z.number().optional().describe('range_customize=true时，必填'),
  }),
}).describe('schema of a Progress field');


export const RatingFieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(2),
  ui_type: z.literal('Rating'),
  property: z.object({
    formatter: z.literal('0'),
    symbol: z.nativeEnum(RatingSymbol).optional(),
    max: z.number().optional().describe('1~10'),
    min: z.number().optional().describe('0 or 1'),
  }),
}).describe('schema of a Rating field');

// // Merge schemas with type 2
// export const Type2FieldSchema = z.object({
//   field_name: z.string(),
//   type: z.literal(2),
//   ui_type: z.enum(['Number', 'Currency', 'Progress', 'Rating']),
//   property: z.object({
//     formatter: z.nativeEnum(NumberFormatter).optional(),
//     currency_code: z.nativeEnum(CurrencyCode).optional(),
//     rating: z.object({
//       symbol: z.nativeEnum(RatingSymbol).optional(),
//     }).optional(),
//   }).optional(),
//   range_customize: z.boolean().optional(),
//   min: z.number().optional(),
//   max: z.number().optional(),
// }).describe('schema of fields with type 2: Number, Currency, Progress, Rating');

// Single Select Field
export const SingleSelectfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(3),
  ui_type: z.literal('SingleSelect'),
  property: z.object({
    options: z.array(z.object({
      name: z.string().optional(),
      id: z.string().optional(),
      color: z.number().min(0).max(54).optional(),
    })).optional(),
  }).optional(),
}).describe('schema of a SingleSelect field');

// Multi Select Field
export const MultiSelectfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(4),
  ui_type: z.literal('MultiSelect'),
  property: z.object({
    options: z.array(z.object({
      name: z.string().optional(),
      id: z.string().optional().describe('用于新建操作时，此字段一定不能填'),
      color: z.number().min(0).max(54).optional(),
    })).optional(),
  }).optional(),
}).describe('schema of a MultiSelect field');

// DateTime Field
export const DateTimefieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(5),
  ui_type: z.literal('DateTime'),
  property: z.object({
    date_formatter: z.nativeEnum(DateFormatter).optional(),
    auto_fill: z.boolean().optional(),
  }).optional(),
}).describe('schema of a DateTime field');

// Checkbox Field
export const CheckboxfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(7),
  ui_type: z.literal('Checkbox'),
}).describe('schema of a Checkbox field');

// User Field
export const UserfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(11),
  ui_type: z.literal('User'),
  property: z.object({
    multiple: z.boolean().optional(),
  }).optional(),
}).describe('schema of a User field');

// Phone Field
export const PhonefieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(13),
  ui_type: z.literal('Phone'),
}).describe('schema of a Phone field');

// URL Field
export const UrlfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(15),
  ui_type: z.literal('Url'),
}).describe('schema of a Url field');

// Attachment Field
export const AttachmentfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(17),
  ui_type: z.literal('Attachment'),
}).describe('schema of a Attachment field');

// Single Link Field
export const SingleLinkfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(18),
  ui_type: z.literal('SingleLink'),
  property: z.object({
    table_id: z.string(),
    multiple: z.boolean().optional(),
  }).optional(),
}).describe('schema of a SingleLink field');

// Lookup Field
export const LookupfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(19),
  // ui_type: z.literal('Lookup'),// 先不加上，sdk 的ui_type还没有这个枚举值
}).describe('schema of a Lookup field');

// Formula Field
export const FormulafieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(20),
  ui_type: z.literal('Formula'),
  property: z.object({
    formatter: z.union([z.nativeEnum(NumberFormatter),z.nativeEnum(DateFormatter)]).optional(),
    formula_expression: z.string().optional(),
  }).optional(),
}).describe('schema of a Formula field');

// Duplex Link Field
export const DuplexLinkfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(21),
  ui_type: z.literal('DuplexLink'),
  property: z.object({
    multiple: z.boolean().optional(),
    table_id: z.string(),
    back_field_name: z.string().optional(),
  }).optional(),
}).describe('schema of a DuplexLink field');

// Location Field
export const LocationfieldSchema = z.object({
  type: z.literal(22),
  field_name: z.string(),
  ui_type: z.literal('Location'),
  // property: z.object({
  //   location: z.object({
  //     input_type: z.enum(['only_mobile','not_limit']).describe('地理位置输入限制，可选值有 only_mobile：仅允许移动端实时定位,not_limit：无限制，可输入任意地理位置'),
  //   }).optional(),
  // }).optional(),
}).describe('schema of a Location field');

// Group Chat Field
export const GroupChatfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(23),
  ui_type: z.literal('GroupChat'),
  property: z.object({
    multiple: z.boolean().optional(),
  }).optional(),
}).describe('schema of a GroupChat field');

// Created Time Field
export const CreatedTimefieldSchema = z.object({
  type: z.literal(1001),
  field_name: z.string(),
  ui_type: z.literal('CreatedTime'),
  property: z.object({
    date_formatter: z.nativeEnum(DateFormatter).optional(),
  }).optional(),
}).describe('schema of a CreatedTime field');

// Modified Time Field
export const ModifiedTimefieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(1002),
  ui_type: z.literal('ModifiedTime'),
}).describe('schema of a ModifiedTime field');

// Created User Field
export const CreatedUserfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(1003),
  ui_type: z.literal('CreatedUser'),
}).describe('schema of a CreatedUser field');

// Modified User Field
export const ModifiedUserfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(1004),
  ui_type: z.literal('ModifiedUser'),
}).describe('schema of a ModifiedUser field');

// Auto Number Field
export const AutoNumberfieldSchema = z.object({
  field_name: z.string(),
  type: z.literal(1005),
  ui_type: z.literal('AutoNumber'),
//   property: z.object({
//     auto_serial: z.object({
//       type: z.enum(['custom','auto_increment_number']),
//       reformat_existing_records: z.boolean().optional(),
//       options: z.array(z.object({
//         type: z.enum(['system_number','fixed_text','created_time']),
//         value: z.string().describe(`。
// - 若规则类型为 "type": "system_number"，value 为范围在 1-9 的整数，表示自增数字的位数
// - 若规则类型为 "type": "fixed_text"，value 为范围在 20 个字符以内的固定字符
// - 若规则类型为 "type": "created_time"，value 用于指定日期的格式。`),
//       })).optional(),
//     }).optional(),
//   }).optional(),
}).describe('schema of a AutoNumber field');

// Update FieldSchema union
export const FieldSchema = z.union([
  BaseFieldSchema,
  Type1FieldSchema,
  CurrencyFieldSchema,
  ProgressFieldSchema,
  RatingFieldSchema,
  // Type2FieldSchema,
  SingleSelectfieldSchema,
  MultiSelectfieldSchema,
  DateTimefieldSchema,
  CheckboxfieldSchema,
  UserfieldSchema,
  PhonefieldSchema,
  UrlfieldSchema,
  AttachmentfieldSchema,
  SingleLinkfieldSchema,
  LookupfieldSchema,
  FormulafieldSchema,
  DuplexLinkfieldSchema,
  LocationfieldSchema,
  GroupChatfieldSchema,
  CreatedTimefieldSchema,
  ModifiedTimefieldSchema,
  CreatedUserfieldSchema,
  ModifiedUserfieldSchema,
  AutoNumberfieldSchema,
]).describe(`Text type=1,Number type=2,SingleSelect type=3,MultiSelect type=4,DateTime type=5,Checkbox type=7,User type=11,Phone type=13,Url type=15,Attachment type=17,SingleLink type=18,Lookup type=19,Formula type=20,DuplexLink type=21,Location type=22,GroupChat type=23,CreatedTime type=1001,ModifiedTime type=1002,CreatedUser type=1003,ModifiedUser type=1004`);
