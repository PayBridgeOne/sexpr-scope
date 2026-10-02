/**
 * A static catalog of standardized `COMMON-LISP` package symbols.
 *
 * This is deliberately *factual language metadata*: the print names and the
 * broad category (function / macro / special operator / type / constant /
 * special variable) of symbols the ANSI standard guarantees are exported from
 * the `COMMON-LISP` package. It lets completion, semantic classification and
 * hover recognise ordinary code such as `(mapcar #'f xs)`, `(when c …)` or
 * `(format t "~a" x)` without indexing any workspace source and, critically,
 * without a running Lisp image — nothing here evaluates Lisp.
 *
 * It is intentionally *not* a copy of the standard's documentation: no docstrings
 * and no invented lambda lists are stored. Richer per-symbol metadata (argument
 * lists, documentation) belongs to a later runtime-enriched milestone; where it
 * cannot be sourced reliably it is omitted rather than guessed.
 *
 * The catalog is not exhaustive — it covers the commonly used portion of the
 * standard — but it is conservative: every entry is a real `CL` symbol, and a
 * name absent from the catalog simply contributes no builtin knowledge.
 */

import { SPECIAL_OPERATORS } from "./language";

/** The broad category of a standardized `COMMON-LISP` symbol. */
export type StandardSymbolKind =
  | "function"
  | "macro"
  | "special-operator"
  | "type"
  | "constant"
  | "variable";

/** The canonical home package of every standardized symbol. */
export const COMMON_LISP_PACKAGE = "COMMON-LISP";

// Standardized macros (CLHS). These are ordinary macros, distinct from the
// special operators in `language.ts`.
const MACROS: readonly string[] = [
  "AND",
  "ASSERT",
  "CASE",
  "CCASE",
  "CHECK-TYPE",
  "COND",
  "CTYPECASE",
  "DECF",
  "DECLAIM",
  "DEFCLASS",
  "DEFCONSTANT",
  "DEFGENERIC",
  "DEFINE-COMPILER-MACRO",
  "DEFINE-CONDITION",
  "DEFINE-METHOD-COMBINATION",
  "DEFINE-MODIFY-MACRO",
  "DEFINE-SETF-EXPANDER",
  "DEFINE-SYMBOL-MACRO",
  "DEFMACRO",
  "DEFMETHOD",
  "DEFPACKAGE",
  "DEFPARAMETER",
  "DEFSETF",
  "DEFSTRUCT",
  "DEFTYPE",
  "DEFUN",
  "DEFVAR",
  "DESTRUCTURING-BIND",
  "DO",
  "DO*",
  "DO-ALL-SYMBOLS",
  "DO-EXTERNAL-SYMBOLS",
  "DO-SYMBOLS",
  "DOLIST",
  "DOTIMES",
  "ECASE",
  "ETYPECASE",
  "FORMATTER",
  "HANDLER-BIND",
  "HANDLER-CASE",
  "IGNORE-ERRORS",
  "IN-PACKAGE",
  "INCF",
  "LAMBDA",
  "LOOP",
  "LOOP-FINISH",
  "MULTIPLE-VALUE-BIND",
  "MULTIPLE-VALUE-LIST",
  "MULTIPLE-VALUE-SETQ",
  "NTH-VALUE",
  "OR",
  "POP",
  "PPRINT-LOGICAL-BLOCK",
  "PRINT-UNREADABLE-OBJECT",
  "PROG",
  "PROG*",
  "PROG1",
  "PROG2",
  "PSETF",
  "PSETQ",
  "PUSH",
  "PUSHNEW",
  "REMF",
  "RESTART-BIND",
  "RESTART-CASE",
  "RETURN",
  "ROTATEF",
  "SETF",
  "SHIFTF",
  "STEP",
  "TIME",
  "TYPECASE",
  "UNLESS",
  "WHEN",
  "WITH-ACCESSORS",
  "WITH-COMPILATION-UNIT",
  "WITH-CONDITION-RESTARTS",
  "WITH-HASH-TABLE-ITERATOR",
  "WITH-INPUT-FROM-STRING",
  "WITH-OPEN-FILE",
  "WITH-OPEN-STREAM",
  "WITH-OUTPUT-TO-STRING",
  "WITH-PACKAGE-ITERATOR",
  "WITH-SIMPLE-RESTART",
  "WITH-SLOTS",
  "WITH-STANDARD-IO-SYNTAX",
];

// Standardized functions (CLHS). A broad, commonly-used subset.
const FUNCTIONS: readonly string[] = [
  "ABS", "ACONS", "ACOS", "ACOSH", "ADJOIN", "ADJUST-ARRAY",
  "ADJUSTABLE-ARRAY-P", "ALPHA-CHAR-P", "ALPHANUMERICP", "APPEND", "APPLY",
  "APROPOS", "APROPOS-LIST", "AREF", "ARRAY-DIMENSION", "ARRAY-DIMENSIONS",
  "ARRAY-ELEMENT-TYPE", "ARRAY-HAS-FILL-POINTER-P", "ARRAY-IN-BOUNDS-P",
  "ARRAY-RANK", "ARRAY-ROW-MAJOR-INDEX", "ARRAY-TOTAL-SIZE", "ARRAYP",
  "ASH", "ASIN", "ASINH", "ASSOC", "ASSOC-IF", "ASSOC-IF-NOT", "ATAN",
  "ATANH", "ATOM", "BIT", "BIT-AND", "BIT-NOT", "BIT-VECTOR-P", "BOOLE",
  "BOTH-CASE-P", "BOUNDP", "BUTLAST", "BYTE", "BYTE-POSITION", "BYTE-SIZE",
  "CAAR", "CADR", "CAR", "CDAR", "CDDR", "CDR", "CEILING", "CELL-ERROR-NAME",
  "CHAR", "CHAR-CODE", "CHAR-DOWNCASE", "CHAR-EQUAL", "CHAR-GREATERP",
  "CHAR-LESSP", "CHAR-NAME", "CHAR-NOT-EQUAL", "CHAR-UPCASE", "CHAR/=",
  "CHAR<", "CHAR<=", "CHAR=", "CHAR>", "CHAR>=", "CHARACTER", "CHARACTERP",
  "CIS", "CLASS-OF", "CLRHASH", "CODE-CHAR", "COERCE", "COMPILE",
  "COMPILE-FILE", "COMPLEMENT", "COMPLEX", "COMPLEXP", "CONCATENATE",
  "CONJUGATE", "CONS", "CONSP", "CONSTANTP", "COPY-ALIST", "COPY-LIST",
  "COPY-SEQ", "COPY-STRUCTURE", "COPY-SYMBOL", "COPY-TREE", "COS", "COSH",
  "COUNT", "COUNT-IF", "COUNT-IF-NOT", "DECODE-FLOAT",
  "DECODE-UNIVERSAL-TIME", "DELETE", "DELETE-DUPLICATES", "DELETE-FILE",
  "DELETE-IF", "DELETE-IF-NOT", "DENOMINATOR", "DIGIT-CHAR", "DIGIT-CHAR-P",
  "DIRECTORY", "DISASSEMBLE", "DOCUMENTATION", "DPB", "ELT", "ENDP",
  "ENOUGH-NAMESTRING", "EQ", "EQL", "EQUAL", "EQUALP", "ERROR", "EVAL",
  "EVENP", "EVERY", "EXP", "EXPORT", "EXPT", "FBOUNDP", "FCEILING",
  "FDEFINITION", "FFLOOR", "FILE-AUTHOR", "FILE-LENGTH", "FILE-NAMESTRING",
  "FILE-POSITION", "FILE-WRITE-DATE", "FILL", "FILL-POINTER", "FIND",
  "FIND-CLASS", "FIND-IF", "FIND-IF-NOT", "FIND-PACKAGE", "FIND-RESTART",
  "FIND-SYMBOL", "FINISH-OUTPUT", "FIRST", "FLOAT", "FLOAT-DIGITS",
  "FLOAT-RADIX", "FLOAT-SIGN", "FLOATP", "FLOOR", "FMAKUNBOUND",
  "FORCE-OUTPUT", "FORMAT", "FRESH-LINE", "FROUND", "FTRUNCATE", "FUNCALL",
  "FUNCTION-LAMBDA-EXPRESSION", "FUNCTIONP", "GCD", "GENSYM", "GENTEMP",
  "GET", "GET-DECODED-TIME", "GET-INTERNAL-REAL-TIME",
  "GET-INTERNAL-RUN-TIME", "GET-OUTPUT-STREAM-STRING", "GET-UNIVERSAL-TIME",
  "GETF", "GETHASH", "GRAPHIC-CHAR-P", "HASH-TABLE-COUNT", "HASH-TABLE-P",
  "HASH-TABLE-REHASH-SIZE", "HASH-TABLE-SIZE", "HASH-TABLE-TEST",
  "HOST-NAMESTRING", "IDENTITY", "IMAGPART", "IMPORT", "INPUT-STREAM-P",
  "INTEGER-DECODE-FLOAT", "INTEGER-LENGTH", "INTEGERP", "INTERN",
  "INTERSECTION", "INVALID-METHOD-ERROR", "ISQRT", "KEYWORDP",
  "LAST", "LCM", "LDB", "LDB-TEST", "LDIFF", "LENGTH", "LISP-IMPLEMENTATION-TYPE",
  "LISP-IMPLEMENTATION-VERSION", "LIST", "LIST*", "LIST-ALL-PACKAGES",
  "LIST-LENGTH", "LISTEN", "LISTP", "LOAD", "LOG", "LOGAND", "LOGANDC1",
  "LOGANDC2", "LOGBITP", "LOGCOUNT", "LOGEQV", "LOGIOR", "LOGNAND",
  "LOGNOR", "LOGNOT", "LOGORC1", "LOGORC2", "LOGTEST", "LOGXOR",
  "LOWER-CASE-P", "MACRO-FUNCTION", "MACROEXPAND", "MACROEXPAND-1",
  "MAKE-ARRAY", "MAKE-BROADCAST-STREAM", "MAKE-CONCATENATED-STREAM",
  "MAKE-CONDITION", "MAKE-ECHO-STREAM", "MAKE-HASH-TABLE", "MAKE-INSTANCE",
  "MAKE-LIST", "MAKE-PACKAGE", "MAKE-PATHNAME", "MAKE-RANDOM-STATE",
  "MAKE-SEQUENCE", "MAKE-STRING", "MAKE-STRING-INPUT-STREAM",
  "MAKE-STRING-OUTPUT-STREAM", "MAKE-SYMBOL", "MAKE-SYNONYM-STREAM",
  "MAKE-TWO-WAY-STREAM", "MAKUNBOUND", "MAP", "MAP-INTO", "MAPC", "MAPCAN",
  "MAPCAR", "MAPCON", "MAPHASH", "MAPL", "MAPLIST", "MASK-FIELD", "MAX",
  "MEMBER", "MEMBER-IF", "MEMBER-IF-NOT", "MERGE", "MIN", "MINUSP", "MISMATCH",
  "MOD", "NAME-CHAR", "NAMESTRING", "NBUTLAST", "NCONC", "NINTERSECTION",
  "NOT", "NOTANY", "NOTEVERY", "NRECONC", "NREVERSE", "NSET-DIFFERENCE",
  "NSET-EXCLUSIVE-OR", "NSTRING-CAPITALIZE", "NSTRING-DOWNCASE",
  "NSTRING-UPCASE", "NSUBLIS", "NSUBST", "NSUBST-IF", "NSUBST-IF-NOT",
  "NSUBSTITUTE", "NSUBSTITUTE-IF", "NSUBSTITUTE-IF-NOT", "NTH", "NTHCDR",
  "NULL", "NUMBERP", "NUMERATOR", "NUNION", "ODDP", "OPEN", "OUTPUT-STREAM-P",
  "PACKAGE-NAME", "PACKAGE-NICKNAMES", "PACKAGE-USE-LIST", "PACKAGE-USED-BY-LIST",
  "PACKAGEP", "PAIRLIS", "PARSE-INTEGER", "PARSE-NAMESTRING", "PATHNAME",
  "PATHNAME-DIRECTORY", "PATHNAME-HOST", "PATHNAME-NAME", "PATHNAME-TYPE",
  "PATHNAMEP", "PEEK-CHAR", "PHASE", "PLUSP", "POSITION", "POSITION-IF",
  "POSITION-IF-NOT", "PPRINT", "PRIN1", "PRIN1-TO-STRING", "PRINC",
  "PRINC-TO-STRING", "PRINT", "PROBE-FILE", "PROCLAIM", "RANDOM", "RANDOM-STATE-P",
  "RASSOC", "RASSOC-IF", "RASSOC-IF-NOT", "RATIONAL", "RATIONALIZE", "RATIONALP",
  "READ", "READ-CHAR", "READ-CHAR-NO-HANG", "READ-FROM-STRING", "READ-LINE",
  "READ-PRESERVING-WHITESPACE", "READ-SEQUENCE", "REALP", "REALPART", "REDUCE",
  "REM", "REMHASH", "REMOVE", "REMOVE-DUPLICATES", "REMOVE-IF", "REMOVE-IF-NOT",
  "REMPROP", "RENAME-FILE", "RENAME-PACKAGE", "REPLACE", "REST", "REVAPPEND",
  "REVERSE", "ROUND", "ROW-MAJOR-AREF", "RPLACA", "RPLACD", "SBIT", "SCALE-FLOAT",
  "SCHAR", "SEARCH", "SECOND", "SET", "SET-DIFFERENCE", "SET-EXCLUSIVE-OR",
  "SIGNAL", "SIGNUM", "SIN", "SINH", "SLEEP", "SOME", "SORT", "SPECIAL-OPERATOR-P",
  "SQRT", "STABLE-SORT", "STANDARD-CHAR-P", "STRING", "STRING-CAPITALIZE",
  "STRING-DOWNCASE", "STRING-EQUAL", "STRING-GREATERP", "STRING-LEFT-TRIM",
  "STRING-LESSP", "STRING-NOT-EQUAL", "STRING-NOT-GREATERP", "STRING-NOT-LESSP",
  "STRING-RIGHT-TRIM", "STRING-TRIM", "STRING-UPCASE", "STRING/=", "STRING<",
  "STRING<=", "STRING=", "STRING>", "STRING>=", "STRINGP", "SUBLIS", "SUBSEQ",
  "SUBSETP", "SUBST", "SUBST-IF", "SUBST-IF-NOT", "SUBSTITUTE", "SUBSTITUTE-IF",
  "SUBSTITUTE-IF-NOT", "SVREF", "SXHASH", "SYMBOL-FUNCTION", "SYMBOL-NAME",
  "SYMBOL-PACKAGE", "SYMBOL-PLIST", "SYMBOL-VALUE", "SYMBOLP", "TAILP", "TAN",
  "TANH", "TENTH", "TERPRI", "THIRD", "TRANSLATE-PATHNAME", "TREE-EQUAL",
  "TRUENAME", "TRUNCATE", "TYPE-OF", "TYPEP", "UNEXPORT", "UNINTERN",
  "UNION", "UNREAD-CHAR", "UNUSE-PACKAGE", "UPPER-CASE-P",
  "USE-PACKAGE", "VALUES", "VALUES-LIST", "VECTOR", "VECTOR-POP", "VECTOR-PUSH",
  "VECTOR-PUSH-EXTEND", "VECTORP", "WARN", "WILD-PATHNAME-P", "WRITE",
  "WRITE-BYTE", "WRITE-CHAR", "WRITE-LINE", "WRITE-SEQUENCE", "WRITE-STRING",
  "WRITE-TO-STRING", "YES-OR-NO-P", "Y-OR-N-P", "ZEROP",
  "1+", "1-", "+", "-", "*", "/", "=", "/=", "<", ">", "<=", ">=",
  "GETHASH", "FUNCALL",
];

// Standardized type/class/condition names (CLHS). A commonly-used subset.
const TYPES: readonly string[] = [
  "ARRAY", "ATOM", "BASE-CHAR", "BASE-STRING", "BIGNUM", "BIT",
  "BIT-VECTOR", "BOOLEAN", "BROADCAST-STREAM", "BUILT-IN-CLASS", "CELL-ERROR",
  "CHARACTER", "CLASS", "COMPLEX", "CONCATENATED-STREAM", "CONDITION", "CONS",
  "CONTROL-ERROR", "DIVISION-BY-ZERO", "DOUBLE-FLOAT", "ECHO-STREAM",
  "END-OF-FILE", "ERROR", "EXTENDED-CHAR", "FILE-ERROR", "FILE-STREAM",
  "FIXNUM", "FLOAT", "FLOATING-POINT-OVERFLOW", "FLOATING-POINT-UNDERFLOW",
  "FUNCTION", "GENERIC-FUNCTION", "HASH-TABLE", "INTEGER", "KEYWORD",
  "LIST", "LOGICAL-PATHNAME", "LONG-FLOAT", "METHOD", "NIL", "NULL", "NUMBER",
  "PACKAGE", "PACKAGE-ERROR", "PARSE-ERROR", "PATHNAME", "PRINT-NOT-READABLE",
  "PROGRAM-ERROR", "RANDOM-STATE", "RATIO", "RATIONAL", "READER-ERROR",
  "READTABLE", "REAL", "SEQUENCE", "SERIOUS-CONDITION", "SHORT-FLOAT",
  "SIGNED-BYTE", "SIMPLE-ARRAY", "SIMPLE-BASE-STRING", "SIMPLE-BIT-VECTOR",
  "SIMPLE-CONDITION", "SIMPLE-ERROR", "SIMPLE-STRING", "SIMPLE-VECTOR",
  "SIMPLE-WARNING", "SINGLE-FLOAT", "STANDARD-CHAR", "STANDARD-CLASS",
  "STANDARD-GENERIC-FUNCTION", "STANDARD-METHOD", "STANDARD-OBJECT",
  "STORAGE-CONDITION", "STREAM", "STREAM-ERROR", "STRING", "STRING-STREAM",
  "STRUCTURE-CLASS", "STRUCTURE-OBJECT", "STYLE-WARNING", "SYMBOL",
  "SYNONYM-STREAM", "TWO-WAY-STREAM", "T", "TYPE-ERROR", "UNBOUND-SLOT",
  "UNBOUND-VARIABLE", "UNDEFINED-FUNCTION", "UNSIGNED-BYTE", "VECTOR",
  "WARNING",
];

// Standardized constant variables (CLHS).
const CONSTANTS: readonly string[] = [
  "ARRAY-DIMENSION-LIMIT", "ARRAY-RANK-LIMIT", "ARRAY-TOTAL-SIZE-LIMIT",
  "BOOLE-1", "BOOLE-2", "BOOLE-AND", "BOOLE-ANDC1", "BOOLE-ANDC2", "BOOLE-C1",
  "BOOLE-C2", "BOOLE-CLR", "BOOLE-EQV", "BOOLE-IOR", "BOOLE-NAND", "BOOLE-NOR",
  "BOOLE-ORC1", "BOOLE-ORC2", "BOOLE-SET", "BOOLE-XOR", "CALL-ARGUMENTS-LIMIT",
  "CHAR-CODE-LIMIT", "DOUBLE-FLOAT-EPSILON", "DOUBLE-FLOAT-NEGATIVE-EPSILON",
  "INTERNAL-TIME-UNITS-PER-SECOND", "LAMBDA-LIST-KEYWORDS",
  "LAMBDA-PARAMETERS-LIMIT", "LEAST-NEGATIVE-DOUBLE-FLOAT",
  "LEAST-NEGATIVE-LONG-FLOAT", "LEAST-NEGATIVE-SHORT-FLOAT",
  "LEAST-NEGATIVE-SINGLE-FLOAT", "LEAST-POSITIVE-DOUBLE-FLOAT",
  "LEAST-POSITIVE-LONG-FLOAT", "LEAST-POSITIVE-SHORT-FLOAT",
  "LEAST-POSITIVE-SINGLE-FLOAT", "LONG-FLOAT-EPSILON",
  "LONG-FLOAT-NEGATIVE-EPSILON", "MOST-NEGATIVE-DOUBLE-FLOAT",
  "MOST-NEGATIVE-FIXNUM", "MOST-NEGATIVE-LONG-FLOAT",
  "MOST-NEGATIVE-SHORT-FLOAT", "MOST-NEGATIVE-SINGLE-FLOAT",
  "MOST-POSITIVE-DOUBLE-FLOAT", "MOST-POSITIVE-FIXNUM",
  "MOST-POSITIVE-LONG-FLOAT", "MOST-POSITIVE-SHORT-FLOAT",
  "MOST-POSITIVE-SINGLE-FLOAT", "MULTIPLE-VALUES-LIMIT", "NIL", "PI",
  "SHORT-FLOAT-EPSILON", "SHORT-FLOAT-NEGATIVE-EPSILON",
  "SINGLE-FLOAT-EPSILON", "SINGLE-FLOAT-NEGATIVE-EPSILON", "T",
];

// Standardized special (dynamic) variables (CLHS).
const VARIABLES: readonly string[] = [
  "*BREAK-ON-SIGNALS*", "*COMPILE-FILE-PATHNAME*", "*COMPILE-FILE-TRUENAME*",
  "*COMPILE-PRINT*", "*COMPILE-VERBOSE*", "*DEBUG-IO*", "*DEBUGGER-HOOK*",
  "*DEFAULT-PATHNAME-DEFAULTS*", "*ERROR-OUTPUT*", "*FEATURES*",
  "*GENSYM-COUNTER*", "*LOAD-PATHNAME*", "*LOAD-PRINT*", "*LOAD-TRUENAME*",
  "*LOAD-VERBOSE*", "*MACROEXPAND-HOOK*", "*MODULES*", "*PACKAGE*",
  "*PRINT-ARRAY*", "*PRINT-BASE*", "*PRINT-CASE*", "*PRINT-CIRCLE*",
  "*PRINT-ESCAPE*", "*PRINT-GENSYM*", "*PRINT-LENGTH*", "*PRINT-LEVEL*",
  "*PRINT-LINES*", "*PRINT-MISER-WIDTH*", "*PRINT-PPRINT-DISPATCH*",
  "*PRINT-PRETTY*", "*PRINT-RADIX*", "*PRINT-READABLY*",
  "*PRINT-RIGHT-MARGIN*", "*QUERY-IO*", "*RANDOM-STATE*", "*READ-BASE*",
  "*READ-DEFAULT-FLOAT-FORMAT*", "*READ-EVAL*", "*READ-SUPPRESS*",
  "*READTABLE*", "*STANDARD-INPUT*", "*STANDARD-OUTPUT*", "*TERMINAL-IO*",
  "*TRACE-OUTPUT*",
];

function toSet(names: readonly string[]): ReadonlySet<string> {
  return new Set(names);
}

const MACRO_SET = toSet(MACROS);
const FUNCTION_SET = toSet(FUNCTIONS);
const TYPE_SET = toSet(TYPES);
const CONSTANT_SET = toSet(CONSTANTS);
const VARIABLE_SET = toSet(VARIABLES);

/**
 * The standardized category of `name` (an upper-cased print name) in the
 * `COMMON-LISP` package, or `undefined` when the name is not a known standard
 * symbol. Special operators are recognised via the central language module so
 * there is a single source of truth for them.
 */
export function standardSymbolKind(name: string): StandardSymbolKind | undefined {
  if (SPECIAL_OPERATORS.has(name)) return "special-operator";
  if (MACRO_SET.has(name)) return "macro";
  if (FUNCTION_SET.has(name)) return "function";
  // Constants/variables are checked before types so the dual-classified names
  // `T` and `NIL` (both constants and type specifiers) resolve as the constant,
  // which is how they appear in value position.
  if (CONSTANT_SET.has(name)) return "constant";
  if (VARIABLE_SET.has(name)) return "variable";
  if (TYPE_SET.has(name)) return "type";
  return undefined;
}

/** True when `name` is a standardized `COMMON-LISP` symbol. */
export function isStandardSymbol(name: string): boolean {
  return standardSymbolKind(name) !== undefined;
}

/** Every standardized symbol name paired with its category (for completion). */
export function standardSymbols(): Array<{ name: string; kind: StandardSymbolKind }> {
  const out: Array<{ name: string; kind: StandardSymbolKind }> = [];
  for (const name of SPECIAL_OPERATORS) out.push({ name, kind: "special-operator" });
  for (const name of MACRO_SET) out.push({ name, kind: "macro" });
  for (const name of FUNCTION_SET) out.push({ name, kind: "function" });
  for (const name of TYPE_SET) out.push({ name, kind: "type" });
  for (const name of CONSTANT_SET) out.push({ name, kind: "constant" });
  for (const name of VARIABLE_SET) out.push({ name, kind: "variable" });
  return out;
}
