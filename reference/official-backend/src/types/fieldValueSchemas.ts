import { z } from "zod";

// 基础类型
const BaseFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]).describe('基础类型');

const TextFieldValueSchema = z.string().describe('文本类型, ui_type=Text'); 
const BarcodeFieldValueSchema = z.string().describe('条码类型, ui_type=Barcode'); 
const NumberFieldValueSchema = z.number().describe('数字类型, ui_type=Number'); 
const ProgressFieldValueSchema = z.number().describe('进度类型, ui_type=Progress'); 
const CurrencyFieldValueSchema = z.number().describe('货币类型, ui_type=Currency'); 
const RatingFieldValueSchema = z.number().describe('评分类型, ui_type=Rating');
const SingleSelectFieldValueSchema = z.string().describe('单选类型, ui_type=SingleSelect');
const MultiSelectFieldValueSchema = z.array(z.string()).describe('多选类型, ui_type=MultiSelect');
const DateTimeFieldValueSchema = z.number().describe('日期时间类型, ui_type=DateTime, Unix 时间戳，单位是毫秒');
const CheckboxFieldValueSchema = z.boolean().describe('复选框类型, ui_type=Checkbox');
const UserFieldValueSchema = z.array(z.object({
  id: z.string().optional()
}).describe('用户类型, ui_type=User, 填写用户的open_id、union_id 或 user_id，默认为open_id'));    

const PhoneFieldValueSchema = z.string().describe('电话号码类型, ui_type=Phone，符合正则表达式 (+)?\d* 的字符串');
const UrlFieldValueSchema = z.object({
  text: z.string().optional(),
  link: z.string().optional()
}).describe('URL类型, ui_type=Url');

const AttachmentFieldValueSchema = z.object({
  file_token: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  size: z.number().optional(),
  url: z.string().optional(),
  tmp_url: z.string().optional()
}).describe('附件类型, ui_type=Attachment');

// 文本链接类型
const TextLinkFieldValueSchema = z.object({
  text: z.string().optional(),
  link: z.string().optional() 
}).describe('超链接类型, ui_type=TextLink');

// 地理位置类型, 25.4.25 验证在创建记录时location只能传字符串，传下面类型会报错'the value of 'Location' must be a string like \"123.456,789.012\'
const LocationFieldValueSchema = z.string()
  .describe('地理位置类型, ui_type=Location, 填写经纬度坐标，用,拼接，例如"123.124,123.124"');
// const LocationSchema = z.object({
//   location: z.string().optional(),
//   pname: z.string().optional(),
//   cityname: z.string().optional(),
//   adname: z.string().optional(),
//   address: z.string().optional(),
//   name: z.string().optional(),
//   full_address: z.string().optional()
// }).describe('地理位置类型');


// 查找
const LookupFieldValueSchema = z.array(z.string()).describe('查找, ui_type=Lookup');
// 关联
const LinkFieldValueSchema = z.array(z.string()).describe('关联, ui_type=SingleLink 或 DuplexLink');

// 组合所有可能的字段值类型
// 先注释一部分 以免给模型的上下文过长
const FieldValueSchema = z.union([
  // BaseFieldValueSchema,
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  // TextFieldValueSchema,
  UserFieldValueSchema,
  // PhoneFieldValueSchema,
  UrlFieldValueSchema,
  AttachmentFieldValueSchema,
  // NumberFieldValueSchema,
  // ProgressFieldValueSchema,
  // CurrencyFieldValueSchema,
  // RatingFieldValueSchema,
  // SingleSelectFieldValueSchema,
  MultiSelectFieldValueSchema,
  DateTimeFieldValueSchema,
  // CheckboxFieldValueSchema,
  // BarcodeFieldValueSchema,
  LookupFieldValueSchema,
  LinkFieldValueSchema,
  LocationFieldValueSchema,
  TextLinkFieldValueSchema,
]);

// 最终的Fields类型
const RecordFieldsSchema = z.record(z.string(), FieldValueSchema).describe('key为字段名，value为字段值，字段名不要用字段ID');

export { RecordFieldsSchema };
