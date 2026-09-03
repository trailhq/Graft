import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFile, languageOf } from "../src/graph/extract.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { genericLangOf } from "../src/graph/generic.js";

test("C# is owned by the depth extractor", () => {
  assert.equal(languageOf("src/Service.CS"), "csharp");
  assert.equal(genericLangOf("src/Service.cs"), null);
});

test("C# extracts declarations and interface member visibility", () => {
  const source = `
public interface IService
{
    void Run();
}

public class Service
{
    public int Count { get; set; }
    private void Hidden() { }
}

public struct Point { }
public enum Mode { Ready, Failed }
public record Data(string Value);
public readonly record struct DataId(int Value);
`;
  const { nodes } = extractFile("Service.cs", source, "csharp");

  const byId = new Map(nodes.map((node) => [node.id, node]));
  assert.equal(byId.get("Service.cs#IService")?.kind, "interface");
  assert.equal(byId.get("Service.cs#IService.Run")?.exported, true);
  assert.equal(byId.get("Service.cs#Service.Count")?.kind, "method");
  assert.equal(byId.get("Service.cs#Service.Count")?.exported, true);
  assert.equal(byId.get("Service.cs#Service.Hidden")?.exported, false);
  assert.equal(byId.get("Service.cs#Point")?.kind, "struct");
  assert.equal(byId.get("Service.cs#Mode")?.kind, "enum");
  assert.equal(byId.get("Service.cs#Data")?.kind, "class");
  assert.equal(byId.get("Service.cs#DataId")?.kind, "class");
});

test("C# resolves interface inheritance and implementation relationships", () => {
  const source = `
public interface IBase { }
public interface IOther { }
public interface IChild : IBase, IOther { }
public class OnlyInterfaces : IBase, IOther { }
public class Parent { }
public class Derived : Parent, IOther { }
public struct Value : IOther { }
public record struct Pair : IOther;
`;
  const { nodes, rawEdges } = extractFile("Types.cs", source, "csharp");
  const edges = resolveEdges(nodes, rawEdges);
  const relation = (sourceId: string, targetId: string): string | undefined =>
    edges.find((edge) => edge.source === sourceId && edge.target === targetId)?.relation;

  assert.equal(relation("Types.cs#IChild", "Types.cs#IBase"), "extends");
  assert.equal(relation("Types.cs#IChild", "Types.cs#IOther"), "extends");
  assert.equal(relation("Types.cs#OnlyInterfaces", "Types.cs#IBase"), "implements");
  assert.equal(relation("Types.cs#OnlyInterfaces", "Types.cs#IOther"), "implements");
  assert.equal(relation("Types.cs#Derived", "Types.cs#Parent"), "extends");
  assert.equal(relation("Types.cs#Derived", "Types.cs#IOther"), "implements");
  assert.equal(relation("Types.cs#Value", "Types.cs#IOther"), "implements");
  assert.equal(relation("Types.cs#Pair", "Types.cs#IOther"), "implements");
});

test("C# field, this-field, parameter, and var receivers retain their types", () => {
  const source = `
public class Primary { public void Execute() { } }
public class Secondary { public void Execute() { } }

public class Consumer
{
    private readonly Primary _field;

    public void Run(Secondary parameter)
    {
        var local = new Secondary();
        _field.Execute();
        this._field.Execute();
        local.Execute();
        parameter.Execute();
    }
}
`;
  const { nodes, rawEdges } = extractFile("Receivers.cs", source, "csharp");
  const calls = rawEdges.filter(
    (edge) => edge.source === "Receivers.cs#Consumer.Run" && edge.name === "Execute",
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.map((call) => call.recvType),
    ["Primary", "Primary", "Secondary", "Secondary"],
  );

  const edges = resolveEdges(nodes, rawEdges).filter(
    (edge) => edge.source === "Receivers.cs#Consumer.Run" && edge.relation === "calls",
  );
  assert.deepEqual(
    edges.map((edge) => edge.target).sort(),
    [
      "Receivers.cs#Primary.Execute",
      "Receivers.cs#Secondary.Execute",
    ].sort(),
  );
});

test("C# implicit-this method calls resolve as member calls", () => {
  const source = `
public class Caller
{
    public void Run() { Helper(); }
    private void Helper() { }
}
`;
  const { nodes, rawEdges } = extractFile("Calls.cs", source, "csharp");
  const rawCall = rawEdges.find((edge) => edge.source === "Calls.cs#Caller.Run" && edge.name === "Helper");
  assert.equal(rawCall?.viaMember, true);
  assert.equal(rawCall?.recvType, "Caller");

  const call = resolveEdges(nodes, rawEdges).find(
    (edge) => edge.source === "Calls.cs#Caller.Run" && edge.relation === "calls",
  );
  assert.equal(call?.target, "Calls.cs#Caller.Helper");
});

test("C# using directives emit the imported namespace or type", () => {
  const source = `
using System;
using static System.Console;
using Text = System.String;
public class Service { }
`;
  const { rawEdges } = extractFile("Imports.cs", source, "csharp");
  assert.deepEqual(
    rawEdges.filter((edge) => edge.relation === "imports").map((edge) => edge.specifier),
    ["System", "System.Console", "System.String"],
  );
});