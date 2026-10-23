CXX ?= g++
CXXFLAGS ?= -O2 -fPIC -std=c++17 -Iinclude
LDFLAGS ?= -shared

TARGET = libboing_text.so
SRC = src/boing_text.cpp

all: $(TARGET)

$(TARGET): $(SRC) include/boing_text.h
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -o $@ $(SRC)

clean:
	rm -f $(TARGET)

install: $(TARGET)
	cp $(TARGET) /usr/local/lib/ 2>/dev/null || true
