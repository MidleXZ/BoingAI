using System.Collections.Concurrent;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://0.0.0.0:5001");

var app = builder.Build();

var store = new ConcurrentDictionary<string, Conversation>();
var memories = new ConcurrentDictionary<string, Memory>();

app.MapGet("/health", () => Results.Ok(new { status = "ok", service = "boingai-memory", version = "1.0.0" }));

app.MapGet("/conversations", () => Results.Ok(store.Values.OrderBy(c => c.CreatedAt).ToList()));

app.MapPost("/conversations", () =>
{
    var c = new Conversation(Guid.NewGuid().ToString("N"), DateTime.UtcNow, new List<Message>());
    store[c.Id] = c;
    return Results.Created($"/conversations/{c.Id}", c);
});

app.MapGet("/conversations/{id}", (string id) =>
    store.TryGetValue(id, out var c) ? Results.Ok(c) : Results.NotFound());

app.MapPost("/conversations/{id}/messages", (string id, MessageInput input) =>
{
    if (!store.TryGetValue(id, out var c)) return Results.NotFound();
    var msg = new Message(input.Role, input.Content, DateTime.UtcNow);
    c.Messages.Add(msg);
    return Results.Ok(msg);
});

app.MapDelete("/conversations/{id}", (string id) =>
    store.TryRemove(id, out _) ? Results.NoContent() : Results.NotFound());

// Memory endpoints
app.MapGet("/memories", () => Results.Ok(memories.Values.OrderBy(m => m.CreatedAt).ToList()));

app.MapPost("/memories", (MemoryInput input) =>
{
    var m = new Memory(Guid.NewGuid().ToString("N"), input.Key, input.Value, DateTime.UtcNow);
    memories[m.Id] = m;
    return Results.Created($"/memories/{m.Id}", m);
});

app.MapPut("/memories/{id}", (string id, MemoryInput input) =>
{
    if (!memories.TryGetValue(id, out var existing)) return Results.NotFound();
    memories[id] = new Memory(id, input.Key, input.Value, existing.CreatedAt);
    return Results.Ok(memories[id]);
});

app.MapDelete("/memories/{id}", (string id) =>
    memories.TryRemove(id, out _) ? Results.NoContent() : Results.NotFound());

app.Run();

record Message(string Role, string Content, DateTime Timestamp);
record MessageInput(string Role, string Content);
record Conversation(string Id, DateTime CreatedAt, List<Message> Messages);
record Memory(string Id, string Key, string Value, DateTime CreatedAt);
record MemoryInput(string Key, string Value);
