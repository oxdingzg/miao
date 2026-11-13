//! Which files are indexed, and how each grammar's node kinds map onto
//! symbols, calls and imports.
//!
//! Every mapping is written as an explicit match on the node kind instead of a
//! tree-sitter query: a query that names one node kind the pinned grammar does
//! not have fails to compile and takes the whole language down with it, while a
//! match arm simply never fires.

use tree_sitter::{Language, Node};

/// Extensions in the order they win; `.d.ts` is TypeScript, not JavaScript.
const EXTENSIONS: &[(&str, &str)] = &[
    ("ts", "typescript"),
    ("mts", "typescript"),
    ("cts", "typescript"),
    ("tsx", "tsx"),
    ("js", "javascript"),
    ("mjs", "javascript"),
    ("cjs", "javascript"),
    ("jsx", "javascript"),
    ("vue", "vue"),
    ("svelte", "svelte"),
    ("astro", "astro"),
    ("rs", "rust"),
    ("py", "python"),
    ("pyi", "python"),
    ("go", "go"),
    ("java", "java"),
    ("kt", "kotlin"),
    ("kts", "kotlin"),
    ("scala", "scala"),
    ("sc", "scala"),
    ("cs", "csharp"),
    ("c", "c"),
    ("h", "c"),
    ("cpp", "cpp"),
    ("cc", "cpp"),
    ("cxx", "cpp"),
    ("hpp", "cpp"),
    ("hh", "cpp"),
    ("hxx", "cpp"),
    ("php", "php"),
    ("rb", "ruby"),
    ("swift", "swift"),
    ("dart", "dart"),
    ("lua", "lua"),
    ("sh", "bash"),
    ("bash", "bash"),
    ("zsh", "bash"),
    ("ksh", "bash"),
    ("html", "html"),
    ("htm", "html"),
    ("sql", "sql"),
    ("m", "objc"),
    ("mm", "objc"),
    ("ex", "elixir"),
    ("exs", "elixir"),
    ("erl", "erlang"),
    ("hrl", "erlang"),
    ("hs", "haskell"),
    ("ml", "ocaml"),
    ("mli", "ocaml"),
    ("fs", "fsharp"),
    ("fsi", "fsharp"),
    ("fsx", "fsharp"),
    ("jl", "julia"),
    ("zig", "zig"),
    ("sol", "solidity"),
    ("proto", "proto"),
    ("graphql", "graphql"),
    ("gql", "graphql"),
    ("tf", "hcl"),
    ("hcl", "hcl"),
    ("ps1", "powershell"),
    ("psm1", "powershell"),
    ("nim", "nim"),
    ("elm", "elm"),
    ("gd", "gdscript"),
    ("cr", "crystal"),
    ("r", "r"),
];

pub const LANGUAGES: &[&str] = &[
    "typescript",
    "tsx",
    "javascript",
    "vue",
    "svelte",
    "astro",
    "rust",
    "python",
    "go",
    "java",
    "kotlin",
    "scala",
    "csharp",
    "c",
    "cpp",
    "php",
    "ruby",
    "swift",
    "dart",
    "lua",
    "bash",
    "html",
    "sql",
    "objc",
    "elixir",
    "erlang",
    "haskell",
    "ocaml",
    "fsharp",
    "julia",
    "zig",
    "solidity",
    "proto",
    "graphql",
    "hcl",
    "powershell",
    "nim",
    "elm",
    "gdscript",
    "crystal",
    "r",
];

/// The parser a language's files are read with. Vue and Svelte are read through
/// their `<script>` block and Astro through its frontmatter, all with the
/// TypeScript grammar, because the surrounding template is not JavaScript.
pub fn grammar(id: &str) -> &str {
    match id {
        "html" => "javascript",
        "vue" | "svelte" | "astro" => "typescript",
        other => other,
    }
}

pub fn language(id: &str) -> Option<Language> {
    Some(match grammar(id) {
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "python" => tree_sitter_python::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "java" => tree_sitter_java::LANGUAGE.into(),
        "kotlin" => tree_sitter_kotlin_ng::LANGUAGE.into(),
        "scala" => tree_sitter_scala::LANGUAGE.into(),
        "csharp" => tree_sitter_c_sharp::LANGUAGE.into(),
        "c" => tree_sitter_c::LANGUAGE.into(),
        "cpp" => tree_sitter_cpp::LANGUAGE.into(),
        "php" => tree_sitter_php::LANGUAGE_PHP.into(),
        "ruby" => tree_sitter_ruby::LANGUAGE.into(),
        "swift" => tree_sitter_swift::LANGUAGE.into(),
        "dart" => tree_sitter_dart::LANGUAGE.into(),
        "lua" => tree_sitter_lua::LANGUAGE.into(),
        "bash" => tree_sitter_bash::LANGUAGE.into(),
        "sql" => tree_sitter_sequel::LANGUAGE.into(),
        "objc" => tree_sitter_objc::LANGUAGE.into(),
        "elixir" => tree_sitter_elixir::LANGUAGE.into(),
        "erlang" => tree_sitter_erlang::LANGUAGE.into(),
        "haskell" => tree_sitter_haskell::LANGUAGE.into(),
        "ocaml" => tree_sitter_ocaml::LANGUAGE_OCAML.into(),
        "fsharp" => tree_sitter_fsharp::LANGUAGE_FSHARP.into(),
        "julia" => tree_sitter_julia::LANGUAGE.into(),
        "zig" => tree_sitter_zig::LANGUAGE.into(),
        "solidity" => tree_sitter_solidity::LANGUAGE.into(),
        "proto" => tree_sitter_proto::LANGUAGE.into(),
        "graphql" => tree_sitter_graphql::LANGUAGE.into(),
        "hcl" => tree_sitter_hcl::LANGUAGE.into(),
        "powershell" => tree_sitter_powershell::LANGUAGE.into(),
        "nim" => tree_sitter_nim::LANGUAGE.into(),
        "elm" => tree_sitter_elm::LANGUAGE.into(),
        "gdscript" => tree_sitter_gdscript::LANGUAGE.into(),
        "crystal" => tree_sitter_crystal::LANGUAGE.into(),
        "r" => tree_sitter_r::LANGUAGE.into(),
        _ => return None,
    })
}

pub fn detect(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name.ends_with(".d.ts") {
        return Some("typescript");
    }
    let extension = name.rsplit_once('.').map(|(_, extension)| extension)?;
    let extension = extension.to_ascii_lowercase();
    EXTENSIONS
        .iter()
        .find(|(candidate, _)| *candidate == extension)
        .map(|(_, language)| *language)
}

pub struct ImportSpec {
    pub source: String,
    pub names: Vec<String>,
    pub line: u32,
}

pub fn text(node: Node, source: &[u8]) -> Option<String> {
    std::str::from_utf8(&source[node.byte_range()])
        .ok()
        .map(str::to_owned)
}

fn field(node: Node, name: &str, source: &[u8]) -> Option<String> {
    text(node.child_by_field_name(name)?, source)
}

fn identifier_like(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_alphabetic() || first == '_' || first == '$' => {}
        _ => return false,
    }
    chars.all(|value| value.is_alphanumeric() || value == '_' || value == '$')
}

fn identifiers(value: &str) -> Vec<String> {
    value
        .split(|character: char| {
            !(character.is_alphanumeric() || character == '_' || character == '$')
        })
        .filter(|part| !part.is_empty())
        .filter(|part| identifier_like(part))
        .map(str::to_owned)
        .collect()
}

fn unquote(value: &str) -> String {
    value
        .trim()
        .trim_start_matches(['"', '\'', '`'])
        .trim_end_matches(['"', '\'', '`'])
        .to_owned()
}

/// Node kinds that spell a name and nothing else.
fn is_name_kind(kind: &str) -> bool {
    matches!(
        kind,
        "identifier"
            | "simple_identifier"
            | "type_identifier"
            | "field_identifier"
            | "property_identifier"
            | "namespace_identifier"
            | "constant"
            | "name"
            | "atom"
            | "word"
            | "value_name"
            | "module_name"
            | "command_name"
            | "lower_case_identifier"
            | "upper_case_identifier"
            | "function_name"
    )
}

/// Peel declarator wrappers (`*`, `[]`, suffixes, parentheses) until the node
/// that actually carries the name is reached. C-family grammars hide a
/// function's name behind two or three such wrappers.
fn declarator_name(node: Node, source: &[u8], depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    if is_name_kind(node.kind()) {
        return text(node, source).filter(|value| identifier_like(value));
    }
    for name in ["declarator", "name", "field", "type", "parameter"] {
        if let Some(child) = node.child_by_field_name(name) {
            if let Some(found) = declarator_name(child, source, depth + 1) {
                return Some(found);
            }
        }
    }
    let mut cursor = node.walk();
    let children = node.children(&mut cursor).collect::<Vec<_>>();
    for child in children {
        if child.is_named() {
            if let Some(found) = declarator_name(child, source, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

/// The last path segment of a dotted, scoped or qualified name.
fn tail_name(node: Node, source: &[u8]) -> Option<String> {
    for name in ["field", "name", "attribute", "property"] {
        if let Some(child) = node.child_by_field_name(name) {
            if let Some(found) = text(child, source) {
                return Some(found);
            }
        }
    }
    declarator_name(node, source, 0)
}

pub fn definition(language: &str, node: Node, source: &[u8]) -> Option<(&'static str, String)> {
    let name = |field_name: &str| field(node, field_name, source);
    Some(match (language, node.kind()) {
        ("typescript" | "tsx" | "javascript", "function_declaration") => {
            ("function", name("name")?)
        }
        ("typescript" | "tsx" | "javascript", "generator_function_declaration") => {
            ("function", name("name")?)
        }
        ("typescript" | "tsx" | "javascript", "class_declaration") => ("class", name("name")?),
        ("typescript" | "tsx" | "javascript", "method_definition") => ("method", name("name")?),
        ("typescript" | "tsx", "interface_declaration") => ("interface", name("name")?),
        ("typescript" | "tsx", "type_alias_declaration") => ("type", name("name")?),
        ("typescript" | "tsx" | "javascript", "enum_declaration") => ("enum", name("name")?),
        ("typescript" | "tsx" | "javascript", "variable_declarator") => {
            let value = node.child_by_field_name("value")?;
            if !matches!(
                value.kind(),
                "arrow_function" | "function_expression" | "function"
            ) {
                return None;
            }
            ("function", name("name")?)
        }
        ("rust", "function_item") => ("function", name("name")?),
        ("rust", "struct_item") => ("struct", name("name")?),
        ("rust", "enum_item") => ("enum", name("name")?),
        ("rust", "trait_item") => ("trait", name("name")?),
        ("rust", "union_item") => ("struct", name("name")?),
        ("rust", "impl_item") => {
            let kind = node
                .child_by_field_name("type")
                .or_else(|| node.child_by_field_name("trait"))?;
            ("impl", text(kind, source)?)
        }
        ("rust", "mod_item") => ("module", name("name")?),
        ("rust", "const_item" | "static_item") => ("const", name("name")?),
        ("rust", "type_item") => ("type", name("name")?),
        ("rust", "macro_definition") => ("macro", name("name")?),
        ("python", "function_definition") => ("function", name("name")?),
        ("python", "class_definition") => ("class", name("name")?),
        ("go", "function_declaration") => ("function", name("name")?),
        ("go", "method_declaration") => ("method", name("name")?),
        ("go", "type_spec") => ("type", name("name")?),
        ("java", "class_declaration" | "record_declaration") => ("class", name("name")?),
        ("java", "interface_declaration" | "annotation_type_declaration") => {
            ("interface", name("name")?)
        }
        ("java", "enum_declaration") => ("enum", name("name")?),
        ("java", "method_declaration" | "constructor_declaration") => ("method", name("name")?),
        ("kotlin", "function_declaration") => ("function", name("name")?),
        ("kotlin", "class_declaration" | "object_declaration") => ("class", name("name")?),
        ("kotlin", "property_declaration") => ("property", declarator_name(node, source, 0)?),
        ("scala", "function_definition") => ("function", name("name")?),
        ("scala", "class_definition" | "object_definition") => ("class", name("name")?),
        ("scala", "trait_definition") => ("interface", name("name")?),
        ("csharp", "class_declaration" | "record_declaration") => ("class", name("name")?),
        ("csharp", "interface_declaration") => ("interface", name("name")?),
        ("csharp", "struct_declaration") => ("struct", name("name")?),
        ("csharp", "enum_declaration") => ("enum", name("name")?),
        ("csharp", "namespace_declaration") => ("module", name("name")?),
        ("csharp", "method_declaration" | "constructor_declaration") => ("method", name("name")?),
        ("csharp", "property_declaration") => ("property", name("name")?),
        ("c" | "cpp", "function_definition") => ("function", declarator_name(node, source, 0)?),
        ("c" | "cpp", "struct_specifier") => ("struct", name("name")?),
        ("c" | "cpp", "enum_specifier") => ("enum", name("name")?),
        ("cpp", "class_specifier") => ("class", name("name")?),
        ("cpp", "namespace_definition") => ("module", name("name")?),
        ("php", "class_declaration") => ("class", name("name")?),
        ("php", "interface_declaration") => ("interface", name("name")?),
        ("php", "trait_declaration") => ("trait", name("name")?),
        ("php", "enum_declaration") => ("enum", name("name")?),
        ("php", "function_definition") => ("function", name("name")?),
        ("php", "method_declaration") => ("method", name("name")?),
        ("ruby", "method" | "singleton_method") => ("method", name("name")?),
        ("ruby", "class") => ("class", name("name")?),
        ("ruby", "module") => ("module", name("name")?),
        ("swift", "function_declaration" | "init_declaration") => ("function", name("name")?),
        ("swift", "class_declaration") => ("class", name("name")?),
        ("swift", "struct_declaration") => ("struct", name("name")?),
        ("swift", "enum_declaration") => ("enum", name("name")?),
        ("swift", "protocol_declaration") => ("interface", name("name")?),
        ("swift", "extension_declaration") => ("module", name("name")?),
        ("dart", "class_declaration" | "mixin_declaration" | "extension_declaration") => {
            ("class", name("name")?)
        }
        ("dart", "enum_declaration") => ("enum", name("name")?),
        ("dart", "function_declaration" | "method_declaration") => (
            "function",
            node.child_by_field_name("signature")
                .and_then(|signature| declarator_name(signature, source, 0))
                .or_else(|| declarator_name(node, source, 0))?,
        ),
        ("lua", "function_declaration") => ("function", tail_name(node, source)?),
        ("r", "binary_operator") => {
            let value = node.child_by_field_name("rhs")?;
            if value.kind() != "function_definition" {
                return None;
            }
            ("function", text(node.child_by_field_name("lhs")?, source)?)
        }
        ("bash", "function_definition") => ("function", name("name")?),
        ("sql", "create_table") => ("table", declarator_name(node, source, 0)?),
        ("sql", "create_function" | "create_procedure") => {
            ("function", declarator_name(node, source, 0)?)
        }
        ("sql", "create_view") => ("view", declarator_name(node, source, 0)?),
        ("objc", "class_interface" | "class_implementation") => {
            ("class", declarator_name(node, source, 0)?)
        }
        ("objc", "method_definition" | "method_declaration") => {
            ("method", declarator_name(node, source, 0)?)
        }
        ("objc", "function_definition") => ("function", declarator_name(node, source, 0)?),
        ("elixir", "call") => elixir_definition(node, source)?,
        ("erlang", "fun_decl") => ("function", declarator_name(node, source, 0)?),
        ("erlang", "module_attribute") => ("module", declarator_name(node, source, 0)?),
        ("haskell", "function") => ("function", name("name")?),
        ("haskell", "data_type" | "class_declaration" | "newtype") => {
            ("type", declarator_name(node, source, 0)?)
        }
        ("ocaml", "let_binding") => ("function", name("pattern")?),
        ("ocaml", "module_binding") => ("module", declarator_name(node, source, 0)?),
        ("fsharp", "function_or_value_defn") => ("function", declarator_name(node, source, 0)?),
        ("julia", "module_definition") => ("module", name("name")?),
        ("julia", "function_definition") => ("function", declarator_name(node, source, 0)?),
        ("zig", "function_declaration") => ("function", name("name")?),
        ("zig", "container_declaration") => ("struct", declarator_name(node, source, 0)?),
        ("solidity", "contract_declaration" | "interface_declaration" | "library_declaration") => {
            ("class", name("name")?)
        }
        ("solidity", "function_definition" | "modifier_definition" | "event_definition") => {
            ("function", name("name")?)
        }
        ("solidity", "struct_declaration" | "enum_declaration") => ("struct", name("name")?),
        ("proto", "message" | "service") => ("class", declarator_name(node, source, 0)?),
        ("proto", "rpc") => ("function", declarator_name(node, source, 0)?),
        ("proto", "enum") => ("enum", declarator_name(node, source, 0)?),
        (
            "graphql",
            "object_type_definition" | "interface_type_definition" | "input_object_type_definition",
        ) => ("class", declarator_name(node, source, 0)?),
        ("graphql", "enum_type_definition") => ("enum", declarator_name(node, source, 0)?),
        ("graphql", "field_definition") => ("method", declarator_name(node, source, 0)?),
        ("hcl", "block") => ("block", block_name(node, source)?),
        ("powershell", "function_statement") => ("function", first_child_name(node, source)?),
        ("nim", "proc_declaration" | "func_declaration" | "method_declaration") => {
            ("function", name("name")?)
        }
        ("nim", "template_declaration" | "macro_declaration") => ("function", name("name")?),
        ("nim", "type_declaration") => ("type", name("name")?),
        ("elm", "value_declaration") => ("function", declarator_name(node, source, 0)?),
        ("elm", "module_declaration") => ("module", declarator_name(node, source, 0)?),
        ("elm", "type_declaration" | "type_alias_declaration") => {
            ("type", declarator_name(node, source, 0)?)
        }
        ("gdscript", "function_definition") => ("function", name("name")?),
        ("gdscript", "class_name_statement") => ("class", name("name")?),
        ("crystal", "method_definition") => ("method", name("name")?),
        ("crystal", "class_declaration" | "module_declaration") => ("class", name("name")?),
        _ => return None,
    })
}

/// The callee name of a call node. Member and scoped forms keep only the last
/// segment, which is what a same-file or imported-name lookup can match.
pub fn callee(language: &str, node: Node, source: &[u8]) -> Option<String> {
    let language = grammar(language);
    let raw = match (language, node.kind()) {
        ("typescript" | "tsx" | "javascript", "call_expression") => {
            field(node, "function", source)?
        }
        ("typescript" | "tsx" | "javascript", "new_expression") => {
            field(node, "constructor", source)?
        }
        ("rust", "call_expression") => field(node, "function", source)?,
        ("rust", "macro_invocation") => field(node, "macro", source)?,
        ("python", "call") => field(node, "function", source)?,
        ("go", "call_expression") => field(node, "function", source)?,
        ("java", "method_invocation") => field(node, "name", source)?,
        ("java", "object_creation_expression") => field(node, "type", source)?,
        ("kotlin", "call_expression") => tail_name(node, source)?,
        ("scala", "call_expression") => field(node, "function", source)?,
        ("csharp", "invocation_expression") => {
            let function = node.child_by_field_name("function")?;
            match function.kind() {
                "member_access_expression" => field(function, "name", source)?,
                "generic_name" => declarator_name(function, source, 0)?,
                _ => text(function, source)?,
            }
        }
        ("csharp", "object_creation_expression") => field(node, "type", source)?,
        ("c" | "cpp", "call_expression") => {
            let function = node.child_by_field_name("function")?;
            match function.kind() {
                "field_expression" => field(function, "field", source)?,
                "qualified_identifier" | "scoped_identifier" => tail_name(function, source)?,
                _ => text(function, source)?,
            }
        }
        ("c" | "cpp", "new_expression") => field(node, "type", source)?,
        ("php", "function_call_expression") => {
            tail_name(node.child_by_field_name("function")?, source)?
        }
        (
            "php",
            "member_call_expression" | "scoped_call_expression" | "nullsafe_member_call_expression",
        ) => field(node, "name", source)?,
        ("php", "object_creation_expression") => tail_name(
            node.child_by_field_name("class")
                .or_else(|| node.named_child(0))?,
            source,
        )?,
        ("ruby", "call" | "command" | "command_call") => field(node, "method", source)?,
        ("swift", "call_expression") => {
            let target = node.child(0)?;
            match target.kind() {
                "navigation_expression" => tail_name(target, source)?,
                _ => declarator_name(target, source, 0)?,
            }
        }
        ("dart", "call_expression") => field(node, "function", source)?,
        ("dart", "member_call_expression") => tail_name(node, source)?,
        ("lua", "function_call") => tail_name(node, source)?,
        ("r", "call") => field(node, "function", source)?,
        ("bash", "command") => field(node, "name", source)?,
        ("sql", "invocation") => declarator_name(node, source, 0)?,
        ("objc", "message_expression") => field(node, "method", source)?,
        ("objc", "call_expression") => field(node, "function", source)?,
        ("elixir", "call") => field(node, "target", source)?,
        ("erlang", "call") => field(node, "expr", source)?,
        ("haskell", "apply") => field(node, "function", source)?,
        ("ocaml", "application_expression") => field(node, "function", source)?,
        ("fsharp", "application_expression") => declarator_name(node, source, 0)?,
        ("julia", "call_expression") => declarator_name(node, source, 0)?,
        ("zig", "call_expression") => field(node, "function", source)?,
        ("solidity", "call_expression") => {
            declarator_name(node.child_by_field_name("function")?, source, 0)?
        }
        ("proto", "rpc") => declarator_name(node, source, 0)?,
        ("graphql", "field") => declarator_name(node, source, 0)?,
        ("hcl", "function_call") => declarator_name(node, source, 0)?,
        ("powershell", "command") => field(node, "command_name", source)?,
        ("nim", "call") => field(node, "name", source)?,
        ("elm", "function_call_expr") => declarator_name(node, source, 0)?,
        ("gdscript", "call") => declarator_name(node, source, 0)?,
        ("crystal", "call") => field(node, "method", source)?,
        _ => return None,
    };
    let value = raw
        .rsplit("::")
        .next()
        .unwrap_or(&raw)
        .rsplit('.')
        .next()
        .unwrap_or(&raw)
        .rsplit('\\')
        .next()
        .unwrap_or(&raw)
        .to_owned();
    identifier_like(&value).then_some(value)
}

pub fn imports(language: &str, root: Node, source: &[u8]) -> Vec<ImportSpec> {
    let mut found = Vec::new();
    collect_imports(language, root, source, &mut found);
    found
}

fn collect_imports(language: &str, node: Node, source: &[u8], found: &mut Vec<ImportSpec>) {
    match (language, node.kind()) {
        ("typescript" | "tsx" | "javascript", "import_statement" | "export_statement") => {
            if let Some(spec) = script_import(language, node, source) {
                found.push(spec);
                return;
            }
        }
        ("rust", "use_declaration") => {
            if let Some(spec) = rust_use(node, source) {
                found.push(spec);
            }
            return;
        }
        ("python", "import_statement" | "import_from_statement") => {
            if let Some(spec) = python_import(node, source) {
                found.push(spec);
            }
            return;
        }
        ("go", "import_spec") => {
            if let Some(spec) = go_import(node, source) {
                found.push(spec);
            }
            return;
        }
        ("java" | "kotlin" | "scala", "import_declaration" | "import") => {
            if let Some(spec) = spaced_import(node, source) {
                found.push(spec);
            }
            return;
        }
        ("csharp", "using_directive") => {
            if let Some(spec) = spaced_import(node, source) {
                found.push(spec);
            }
            return;
        }
        ("c" | "cpp", "preproc_include") => {
            if let Some(spec) = include(node, source) {
                found.push(spec);
            }
            return;
        }
        ("php", "namespace_use_declaration") => {
            if let Some(spec) = php_use(node, source) {
                found.push(spec);
            }
            return;
        }
        ("swift", "import_declaration") => {
            if let Some(spec) = spaced_import(node, source) {
                found.push(spec);
            }
            return;
        }
        ("dart", "library_import" | "import_specification") => {
            if let Some(spec) = dart_import(node, source) {
                found.push(spec);
            }
            return;
        }
        ("ruby", "call") | ("lua", "function_call") | ("r", "call") => {
            if let Some(spec) = required_module(language, node, source) {
                found.push(spec);
            }
        }
        ("bash", "command") => {
            if let Some(spec) = bash_source(node, source) {
                found.push(spec);
            }
        }
        ("objc", "preproc_include") => {
            if let Some(spec) = include(node, source) {
                found.push(spec);
            }
            return;
        }
        ("elixir", "call") => {
            if let Some(spec) = elixir_import(node, source) {
                found.push(spec);
            }
        }
        (
            "haskell" | "fsharp" | "ocaml" | "julia" | "nim" | "elm" | "proto" | "solidity",
            "import" | "open_statement" | "import_statement" | "using_statement" | "import_clause"
            | "import_directive",
        ) => {
            if let Some(spec) = keyword_import(node, source) {
                found.push(spec);
            }
        }
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.is_missing() {
            continue;
        }
        collect_imports(language, child, source, found);
    }
}

fn script_import(_language: &str, node: Node, source: &[u8]) -> Option<ImportSpec> {
    let target = unquote(&field(node, "source", source)?);
    let whole = text(node, source)?;
    let clause = match whole.split_once(" from ") {
        Some((clause, _)) => clause.to_owned(),
        None if whole.starts_with("export") => return None,
        None => whole,
    };
    let names = identifiers(&clause)
        .into_iter()
        .filter(|name| !matches!(name.as_str(), "import" | "export" | "type" | "as" | "from"))
        .collect();
    Some(ImportSpec {
        source: target,
        names,
        line: node.start_position().row as u32 + 1,
    })
}

fn rust_use(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let whole = text(node, source)?;
    let body = whole
        .trim_start_matches("use ")
        .trim_end_matches(';')
        .trim();
    let (prefix, names) = match body.split_once('{') {
        Some((prefix, rest)) => {
            let inner = rest.trim_end_matches(['}', ';']);
            let names = inner
                .split(',')
                .filter_map(|entry| {
                    let entry = entry.trim();
                    if entry.is_empty() || entry == "self" {
                        return None;
                    }
                    let entry = match entry.split_once(" as ") {
                        Some((_, alias)) => alias.trim().to_owned(),
                        None => entry.to_owned(),
                    };
                    entry
                        .rsplit("::")
                        .next()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                })
                .collect();
            (prefix.trim_end_matches("::").to_owned(), names)
        }
        None => {
            let (path, alias) = match body.split_once(" as ") {
                Some((path, alias)) => (path.trim(), Some(alias.trim().to_owned())),
                None => (body, None),
            };
            let name = alias.or_else(|| path.rsplit("::").next().map(str::to_owned))?;
            let prefix = path
                .rsplit_once("::")
                .map(|(prefix, _)| prefix.to_owned())
                .unwrap_or_default();
            (prefix, vec![name])
        }
    };
    Some(ImportSpec {
        source: format!("rust::{prefix}"),
        names,
        line: node.start_position().row as u32 + 1,
    })
}

fn python_import(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let whole = text(node, source)?;
    let body = whole.trim();
    let (module, names) = match body.strip_prefix("from ") {
        Some(rest) => {
            let (module, names) = rest.split_once(" import ")?;
            (
                module.trim().to_owned(),
                names
                    .split(',')
                    .filter_map(|entry| {
                        let entry = entry.trim().trim_matches(['(', ')']);
                        let name = entry.split(" as ").next()?.trim();
                        (!name.is_empty() && name != "*").then(|| name.to_owned())
                    })
                    .collect(),
            )
        }
        None => {
            let rest = body.strip_prefix("import ")?;
            (rest.trim().to_owned(), identifiers(rest))
        }
    };
    Some(ImportSpec {
        source: format!("python::{module}"),
        names,
        line: node.start_position().row as u32 + 1,
    })
}

fn go_import(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let whole = text(node, source)?;
    let trimmed = whole.trim();
    let target = unquote(
        trimmed
            .rsplit('"')
            .nth(1)
            .or_else(|| trimmed.rsplit('\'').nth(1))
            .map(|value| value.trim_start_matches('"').trim_start_matches('\''))
            .unwrap_or(trimmed),
    );
    let alias = trimmed
        .split_whitespace()
        .next()
        .filter(|value| *value != "\"");
    let names = match alias {
        Some(alias) if !alias.starts_with('"') => vec![alias.to_owned()],
        _ => target
            .rsplit('/')
            .next()
            .map(|name| vec![name.to_owned()])
            .unwrap_or_default(),
    };
    Some(ImportSpec {
        source: format!("go::{target}"),
        names,
        line: node.start_position().row as u32 + 1,
    })
}

fn spaced_import(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let whole = text(node, source)?;
    let body = whole
        .trim()
        .trim_start_matches("import")
        .trim_start_matches("using")
        .trim_end_matches(';')
        .trim();
    let body = body
        .trim_start_matches("static")
        .trim_start_matches("scala.")
        .trim();
    if body.is_empty() || body.starts_with('"') {
        return None;
    }
    let path = body.split_whitespace().next().unwrap_or(body);
    let (path, selectors) = match path.split_once('{') {
        Some((path, rest)) => (path.trim_end_matches('.'), Some(rest.trim_end_matches('}'))),
        None => (path, None),
    };
    let names = match selectors {
        Some(selectors) => selectors
            .split(',')
            .filter_map(|entry| {
                let name = entry.trim().split(" as ").next()?.trim();
                (!name.is_empty() && name != "_").then(|| name.to_owned())
            })
            .collect::<Vec<_>>(),
        None => vec![path.rsplit(['.', '/']).next().unwrap_or(path).to_owned()],
    };
    Some(ImportSpec {
        source: format!("path::{path}"),
        names,
        line: node.start_position().row as u32 + 1,
    })
}

fn include(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let target = unquote(&field(node, "path", source)?);
    let name = target
        .rsplit('/')
        .next()
        .unwrap_or(&target)
        .trim_end_matches(".h")
        .trim_end_matches(".hpp")
        .to_owned();
    Some(ImportSpec {
        source: format!("include::{target}"),
        names: vec![name],
        line: node.start_position().row as u32 + 1,
    })
}

fn php_use(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let whole = text(node, source)?;
    let body = whole
        .trim()
        .trim_start_matches("use")
        .trim_end_matches(';')
        .trim();
    let body = match body.split_once('{') {
        Some((prefix, rest)) => format!("{}{}", prefix, rest.trim_end_matches('}')),
        None => body.to_owned(),
    };
    let names = body
        .split(',')
        .filter_map(|entry| {
            let entry = entry.trim().trim_start_matches('\\');
            let path = entry.split(" as ").next()?.trim();
            path.rsplit('\\').next().map(str::to_owned)
        })
        .collect();
    Some(ImportSpec {
        source: format!("php::{body}"),
        names,
        line: node.start_position().row as u32 + 1,
    })
}

fn dart_import(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let whole = text(node, source)?;
    let target = whole
        .split(['\'', '"'])
        .nth(1)
        .map(str::to_owned)
        .unwrap_or_default();
    if target.is_empty() {
        return None;
    }
    let names = whole
        .split_once(" show ")
        .map(|(_, rest)| {
            rest.trim_end_matches(';')
                .split(',')
                .map(|name| name.trim().to_owned())
                .collect()
        })
        .unwrap_or_else(|| {
            vec![target
                .rsplit('/')
                .next()
                .unwrap_or(&target)
                .trim_end_matches(".dart")
                .to_owned()]
        });
    Some(ImportSpec {
        source: format!("dart::{target}"),
        names,
        line: node.start_position().row as u32 + 1,
    })
}

/// Languages that load a module through a call (`require "json"`,
/// `require("mod")`, `library(jsonlite)`) rather than a statement.
fn required_module(language: &str, node: Node, source: &[u8]) -> Option<ImportSpec> {
    let name = match language {
        "ruby" => field(node, "method", source)?,
        "lua" | "r" => field(node, "function", source)?,
        _ => return None,
    };
    if !matches!(
        name.as_str(),
        "require" | "require_relative" | "library" | "requireNamespace" | "load"
    ) {
        return None;
    }
    let whole = text(node, source)?;
    let target = whole
        .split(['\'', '"'])
        .nth(1)
        .map(str::to_owned)
        .or_else(|| {
            node.named_child(0)
                .and_then(|arguments| arguments.named_child(0))
                .and_then(|argument| text(argument, source))
        })?;
    let target = unquote(&target);
    if target.is_empty() {
        return None;
    }
    let names = vec![target
        .rsplit('/')
        .next()
        .unwrap_or(&target)
        .trim_end_matches(".rb")
        .trim_end_matches(".lua")
        .to_owned()];
    Some(ImportSpec {
        source: format!("module::{target}"),
        names,
        line: node.start_position().row as u32 + 1,
    })
}

/// Elixir spells every definition as a call to a macro, so the shape of the
/// arguments decides whether a `call` node is a definition and what it names.
fn elixir_definition(node: Node, source: &[u8]) -> Option<(&'static str, String)> {
    let target = field(node, "target", source)?;
    let arguments = elixir_arguments(node)?;
    match target.as_str() {
        "defmodule" => Some(("module", declarator_name(arguments, source, 0)?)),
        "defstruct" => Some(("struct", declarator_name(arguments, source, 0)?)),
        "def" | "defp" | "defmacro" | "defmacrop" | "defguard" | "defguardp" => {
            let head = arguments.named_child(0)?;
            if head.kind() != "call" {
                return None;
            }
            Some(("function", field(head, "target", source)?))
        }
        _ => None,
    }
}

/// Elixir's grammar spells `arguments` positionally rather than as a field, so
/// a field lookup alone would miss every definition.
fn elixir_arguments(node: Node) -> Option<Node> {
    if let Some(arguments) = node.child_by_field_name("arguments") {
        return Some(arguments);
    }
    (0..node.named_child_count()).find_map(|index| {
        let index = u32::try_from(index).ok()?;
        node.named_child(index)
            .filter(|child| child.kind() == "arguments")
    })
}

/// HCL keeps a block's name in its label: `resource "aws_instance" "web"`.
fn block_name(node: Node, source: &[u8]) -> Option<String> {
    let kind = text(node.named_child(0)?, source)?;
    let mut cursor = node.walk();
    let label = node
        .named_children(&mut cursor)
        .find(|child| child.kind() == "string_lit")
        .and_then(|child| text(child, source))
        .map(|value| unquote(&value));
    Some(match label {
        Some(label) => format!("{kind}.{label}"),
        None => kind,
    })
}

/// The first child's text with no identifier filter: PowerShell function names
/// are hyphenated (`Get-Thing`) and would fail an identifier check.
fn first_child_name(node: Node, source: &[u8]) -> Option<String> {
    let name = text(node.named_child(0)?, source)?;
    let name = name.trim().to_owned();
    let starts = name
        .chars()
        .next()
        .is_some_and(|first| first.is_alphanumeric() || first == '_');
    (starts && !name.is_empty()).then_some(name)
}

fn bash_source(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let name = field(node, "name", source)?;
    if !matches!(name.trim(), "source" | ".") {
        return None;
    }
    let whole = text(node, source)?;
    let target = whole.split_whitespace().nth(1)?.trim_matches(['"', '\'']);
    let target = target.trim_start_matches("./");
    if target.is_empty() {
        return None;
    }
    let names = vec![target
        .rsplit('/')
        .next()
        .unwrap_or(target)
        .trim_end_matches(".sh")
        .to_owned()];
    Some(ImportSpec {
        source: format!("module::{target}"),
        names,
        line: node.start_position().row as u32 + 1,
    })
}

fn elixir_import(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let target = field(node, "target", source)?;
    if !matches!(target.as_str(), "import" | "alias" | "require" | "use") {
        return None;
    }
    let arguments = elixir_arguments(node)?;
    let module = text(arguments.named_child(0)?, source)?;
    let name = module.rsplit('.').next()?.to_owned();
    Some(ImportSpec {
        source: format!("path::{module}"),
        names: vec![name],
        line: node.start_position().row as u32 + 1,
    })
}

/// Imports written as a keyword followed by a module path, which covers
/// Haskell, F#, OCaml, Julia, Nim, Elm, Protobuf and Solidity. A path may be
/// bare (`Data.List`) or quoted (`import "api.proto"`).
fn keyword_import(node: Node, source: &[u8]) -> Option<ImportSpec> {
    let whole = text(node, source)?;
    let body = whole
        .trim()
        .trim_start_matches("import")
        .trim_start_matches("open")
        .trim_start_matches("using")
        .trim_end_matches(';')
        .trim();
    let module = if body.starts_with(['"', '\'']) {
        unquote(body.split(['"', '\'']).nth(1)?)
    } else {
        body.split(|character: char| {
            character.is_whitespace() || character == ',' || character == ';'
        })
        .next()?
        .trim_matches(['(', ')'])
        .to_owned()
    };
    if module.is_empty() {
        return None;
    }
    let name = module
        .rsplit(['.', '/', ':'])
        .next()
        .unwrap_or(module.as_str())
        .to_owned();
    Some(ImportSpec {
        source: format!("path::{module}"),
        names: vec![name],
        line: node.start_position().row as u32 + 1,
    })
}

/// Names that never resolve to a workspace definition. Recording them would
/// cost a lookup per call site and inflate the unresolved count with stdlib
/// noise, so they are dropped at extraction time. The list stays deliberately
/// short: a name a project is likely to define itself (`new`, `get`, `run`,
/// `render`, `Close`) is kept so its calls can still land.
pub fn builtin(language: &str) -> &'static [&'static str] {
    match grammar(language) {
        "rust" => &[
            "println",
            "print",
            "eprintln",
            "eprint",
            "format",
            "write",
            "writeln",
            "vec",
            "panic",
            "assert",
            "assert_eq",
            "assert_ne",
            "debug_assert",
            "debug_assert_eq",
            "unreachable",
            "todo",
            "unimplemented",
            "matches",
            "concat",
            "include_str",
            "include_bytes",
            "env",
            "stringify",
            "dbg",
            "unwrap",
            "expect",
            "clone",
            "to_string",
            "to_owned",
            "as_str",
            "as_ref",
            "as_mut",
            "len",
            "is_empty",
            "iter",
            "iter_mut",
            "into_iter",
            "collect",
            "and_then",
            "ok_or",
            "ok_or_else",
            "unwrap_or",
            "unwrap_or_else",
            "unwrap_or_default",
            "default",
        ],
        "typescript" | "tsx" | "javascript" => &[
            "log",
            "error",
            "warn",
            "info",
            "debug",
            "stringify",
            "parse",
            "keys",
            "values",
            "entries",
            "assign",
            "then",
            "catch",
            "finally",
            "map",
            "filter",
            "reduce",
            "forEach",
            "push",
            "pop",
            "slice",
            "splice",
            "join",
            "split",
            "trim",
            "toLowerCase",
            "toUpperCase",
            "replace",
            "includes",
            "indexOf",
            "sort",
            "require",
            "resolve",
        ],
        "python" => &[
            "print",
            "len",
            "range",
            "str",
            "int",
            "float",
            "bool",
            "dict",
            "list",
            "set",
            "append",
            "extend",
            "items",
            "format",
            "join",
            "split",
            "strip",
            "startswith",
            "endswith",
            "lower",
            "upper",
            "replace",
            "super",
        ],
        "go" => &[
            "len", "cap", "make", "append", "copy", "delete", "panic", "recover", "print",
            "println",
        ],
        "java" | "kotlin" | "scala" => &[
            "println",
            "print",
            "printf",
            "toString",
            "equals",
            "hashCode",
            "size",
            "add",
            "put",
            "remove",
            "isEmpty",
            "foreach",
            "flatMap",
            "apply",
            "let",
            "also",
            "with",
            "require",
            "check",
            "error",
            "listOf",
            "mapOf",
            "setOf",
            "sequenceOf",
        ],
        "csharp" => &[
            "WriteLine",
            "Write",
            "ToString",
            "Equals",
            "GetHashCode",
            "Contains",
            "Any",
            "Select",
            "Where",
            "ToList",
            "First",
            "FirstOrDefault",
            "Count",
            "NameOf",
            "Throw",
            "ConfigureAwait",
            "GetType",
        ],
        "c" | "cpp" => &[
            "printf", "fprintf", "sprintf", "snprintf", "malloc", "calloc", "realloc", "free",
            "memcpy", "memset", "strlen", "strcmp", "strcpy", "sizeof", "exit", "abort",
        ],
        "php" => &[
            "count",
            "is_array",
            "is_string",
            "is_null",
            "in_array",
            "array_map",
            "array_filter",
            "array_merge",
            "array_keys",
            "array_values",
            "strlen",
            "str_replace",
            "sprintf",
            "printf",
            "var_dump",
            "json_encode",
            "json_decode",
            "implode",
            "explode",
        ],
        "ruby" => &[
            "puts",
            "print",
            "require",
            "require_relative",
            "attr_accessor",
            "attr_reader",
            "attr_writer",
            "include",
            "extend",
            "each",
            "select",
            "reject",
            "to_s",
            "to_sym",
            "freeze",
            "raise",
        ],
        "swift" => &[
            "print",
            "assert",
            "precondition",
            "fatalError",
            "append",
            "map",
            "filter",
            "reduce",
            "forEach",
            "sorted",
            "contains",
            "isEmpty",
            "count",
        ],
        "dart" => &[
            "print", "toString", "add", "remove", "forEach", "map", "where", "then", "length",
            "isEmpty", "push", "pop", "assert",
        ],
        "lua" => &[
            "print",
            "pairs",
            "ipairs",
            "require",
            "pcall",
            "xpcall",
            "error",
            "assert",
            "type",
            "tostring",
            "tonumber",
            "setmetatable",
        ],
        "r" => &[
            "print",
            "cat",
            "paste",
            "paste0",
            "length",
            "list",
            "data.frame",
            "lapply",
            "sapply",
            "vapply",
            "stop",
            "warning",
            "library",
            "require",
            "requireNamespace",
        ],
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_pick_one_language() {
        assert_eq!(detect("a/b/c.ts"), Some("typescript"));
        assert_eq!(detect("a/b/c.d.ts"), Some("typescript"));
        assert_eq!(detect("a/b/c.tsx"), Some("tsx"));
        assert_eq!(detect("a/b/c.jsx"), Some("javascript"));
        assert_eq!(detect("crates/x/src/lib.rs"), Some("rust"));
        assert_eq!(detect("a/b/App.vue"), Some("vue"));
        assert_eq!(detect("a/b/App.svelte"), Some("svelte"));
        assert_eq!(detect("a/b/page.astro"), Some("astro"));
        assert_eq!(detect("a/b/Main.java"), Some("java"));
        assert_eq!(detect("a/b/lib.cpp"), Some("cpp"));
        assert_eq!(detect("a/b/lib.h"), Some("c"));
        assert_eq!(detect("a/b/Program.cs"), Some("csharp"));
        assert_eq!(detect("a/b/index.php"), Some("php"));
        assert_eq!(detect("a/b/app.rb"), Some("ruby"));
        assert_eq!(detect("a/b/App.swift"), Some("swift"));
        assert_eq!(detect("a/b/Main.kt"), Some("kotlin"));
        assert_eq!(detect("a/b/Main.scala"), Some("scala"));
        assert_eq!(detect("a/b/main.dart"), Some("dart"));
        assert_eq!(detect("a/b/init.lua"), Some("lua"));
        assert_eq!(detect("a/b/analysis.R"), Some("r"));
        assert_eq!(detect("a/b/README.md"), None);
        assert_eq!(detect("Makefile"), None);
    }

    #[test]
    fn single_file_components_parse_with_the_typescript_grammar() {
        assert_eq!(grammar("vue"), "typescript");
        assert_eq!(grammar("svelte"), "typescript");
        assert_eq!(grammar("astro"), "typescript");
        assert_eq!(grammar("java"), "java");
    }
}
