using System.Collections.Concurrent;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://0.0.0.0:5001");

var app = builder.Build();

var store = new ConcurrentDictionary<string, Conversation>();

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

app.Run();

record Message(string Role, string Content, DateTime Timestamp);
record MessageInput(string Role, string Content);
record Conversation(string Id, DateTime CreatedAt, List<Message> Messages);
